import os from 'node:os';
import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import launcher from '@soundworks/helpers/launcher.js';
import { execSync } from 'node:child_process';
import { Worker } from 'worker_threads';

import { loadConfig } from '../../utils/load-config.js';

import pluginFilesystem from '@soundworks/plugin-filesystem/client.js';

import { Scheduler } from '@ircam/sc-scheduling'; 

import { 
  AudioContext,
  AudioBufferSourceNode,
  DynamicsCompressorNode,
  GainNode,
} from 'node-web-audio-api'; 

import { dbtoa } from '@ircam/sc-utils';
import { AudioBufferLoader } from '@ircam/sc-loader';

import createKDTree from 'static-kdtree';

import { performance } from 'node:perf_hooks';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

const audioContext = new AudioContext(); 

const audioBufferLoader = new AudioBufferLoader({});

async function bootstrap() {
  /**
   * Load configuration from config files and create the soundworks client
   */
  const config = loadConfig(process.env.ENV, import.meta.url);
  const client = new Client(config);

  /**
   * Register some soundworks plugins, you will need to install the plugins
   * before hand (run `npx soundworks` for help)
   */
  // client.pluginManager.register('my-plugin', plugin);
  // client.pluginManager.register('filesystem', pluginFilesystem, {});
  
  client.pluginManager.register('filesystem-soundbank', pluginFilesystem, {});
  client.pluginManager.register('filesystem-analysis', pluginFilesystem, {});

  /**
   * Register the soundworks client into the launcher
   *
   * Automatically restarts the process when the socket closes or when an
   * uncaught error occurs in the program.
   */
  launcher.register(client);

  /**
   * Launch application
   */
  await client.start();

  const filesystemSoundbank = await client.pluginManager.get('filesystem-soundbank');

  const satellite = await client.stateManager.create('satellite', {name: os.hostname()});
  const controllers = await client.stateManager.getCollection('controller');
  const global = await client.stateManager.attach('global');
  let group = null;

  const buffers = {};
  for (const fileNode of filesystemSoundbank.getTree().children) {
    const { useHttps, serverAddress, port } = config.env;
    const url = `${useHttps ? 'https' : 'http'}://${serverAddress}:${port}${fileNode.url}`;
    // const path = `${config.env.serverAddress}/${fileNode.url}`;
    const buffer = await audioBufferLoader.load(url);
    buffers[fileNode.name] = buffer;
  } 

  filesystemSoundbank.onUpdate(async updates => {
    for (const event of updates.events) {
      if (event.type === 'create') {
        const buffer = await audioBufferLoader.load(event.node.path);
        buffers[event.node.name] = buffer;
      }
      if (event.type === 'delete') {
        delete buffers[event.node.name];
      }
    }
  });

  satellite.onUpdate(updates => {
    Object.entries(updates).forEach(async ([key, value]) => {
      switch (key) {
        case 'reboot': {
          execSync('sudo reboot now');
          break;
        }
        case 'group': {
          if (group) {
            await group.detach();
          }
          if (value) {
            group = await client.stateManager.attach('group', value);
            group.onUpdate(updates => {
              Object.entries(updates).forEach(([keyG, valueG]) => {
                switch (keyG) {
                  case 'sourceData': {
                    if (valueG) {
                      const buffer = buffers[valueG.name];
                      const analysisData = JSON.parse(valueG.data);
                      // const kdTree = createKDTree.deserialize(analysisData.serializedTree);
                      synthesisEngine.setBuffer(buffer);
                      synthesisEngine.setSearchSpace(analysisData.serializedTree, analysisData.times);
                    }
                    break;
                  }
                  case 'playing': {
                    synthesisEngine.playing = valueG;
                    break;
                  }
                  case 'volume': {
                    synthesisEngine.volume = valueG;
                    break;
                  }
                  case 'detune': {
                    synthesisEngine.detune = valueG;
                    break;
                  }
                  case 'grainPeriod': {
                    synthesisEngine.grainPeriod = valueG;
                    break;
                  }
                  case 'grainDuration': {
                    synthesisEngine.grainDuration = valueG;
                    break;
                  }
                  case 'randomizer': {
                    synthesisEngine.randomizer = valueG;
                    break;
                  }
                }
              });
            }, true);
            group.onDetach(() => {
              group = null;
              synthesisEngine.playing = false;
            });
          } else {
            group = null;
            synthesisEngine.playing = false;
          }
          // console.log("after", group);
          break;
        }
      }
    })
  });

  controllers.onUpdate((state, updates) => {
    Object.entries(updates).forEach(([key, value]) => {
      switch (key) {
        case 'analysisData': {
          synthesisEngine.setTarget(value)
          break;
        }
      }
    });
  });

  //synthesis
  const scheduler = new Scheduler(() => audioContext.currentTime);


  class SynthesisEngine {
    constructor() {
      this.jitter = 0.004;

      this.playing = false;

      this.detune = 0;
      this.grainPeriod = 0.1;
      this.grainDuration = 0.25;
      this._randomizer = 1;

      this.output = new GainNode(audioContext);

      this.searchWorker = new Worker('./src/clients/satellite/search.worker.js');
      this.searchWorker.on('message', e => {
        const {type, data} = e;
        if (type === 'target') {
          const {time, targets, rms, randomizer} = data;
          this.play(time, targets, rms, randomizer);
        }
      });

      this.tick = this.tick.bind(this);
    }

    setSearchSpace(kdTree, times) {
      this.kdTree = kdTree;
      this.times = times;

      this.searchWorker.postMessage({
        type: 'tree',
        data: {
          tree: kdTree,
        }
      });
    }

    setBuffer(buffer) {
      this.buffer = buffer;
    }
    
    set volume(value) {
      const now = audioContext.currentTime;
      this.output.gain.linearRampToValueAtTime(dbtoa(value), now + 0.05);
    }

    set randomizer(value) {
      this._randomizer = Math.floor(value);
    }


    setTarget(x) {
      this.currGrainMfcc = x[0];
      this.currGrainRms = x[1];
    }

    connect(dest) {
      this.output.connect(dest);
    }

    play(time, targets, rms, randomizer) {
      const randK = Math.floor(Math.random() * randomizer);
      const target = targets[randK];
      const timeOffset = this.times[target];

      const rand = Math.random() * this.jitter;
      const now = time + rand;

      const rmsGain = new GainNode(audioContext);
      rmsGain.connect(this.output);
      rmsGain.gain.value = rms;

      const env = new GainNode(audioContext);
      env.connect(rmsGain);
      env.gain.value = 0;
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(1, now + (this.grainDuration / 2));
      env.gain.linearRampToValueAtTime(0, now + this.grainDuration);

      const source = new AudioBufferSourceNode(audioContext);
      source.connect(env);
      source.buffer = this.buffer;
      source.detune.value = this.detune * 100;
      source.start(now, timeOffset, this.grainDuration);
      source.stop(now + this.grainDuration);
    }

    tick(time) {
      time = Math.max(time, audioContext.currentTime);
      if (this.playing && this.kdTree && this.currGrainMfcc) {
        this.searchWorker.postMessage({
          type: 'target',
          data: {
            mfcc: this.currGrainMfcc,
            rms: this.currGrainRms,
            randomizer: this._randomizer,
            time: time,
          }
        });
      }

      return time + this.grainPeriod;
    } 
  }

  const synthesisEngine = new SynthesisEngine();

  scheduler.add(synthesisEngine.tick, audioContext.currentTime);

  // audio path
  const outputNode = new GainNode(audioContext);
  const compressor = new DynamicsCompressorNode(audioContext, {
    threshold: -30,
    knee: 0.1,
    ratio: 2,
    attack: 0.01,
    release: 0.1,
  });
  const busNode = new GainNode(audioContext);

  synthesisEngine.connect(busNode);
  busNode.connect(compressor);
  compressor.connect(outputNode);
  outputNode.connect(audioContext.destination);

  console.log(`Hello ${client.config.app.name}!`);
}

// The launcher allows to fork multiple clients in the same terminal window
// by defining the `EMULATE` env process variable
// e.g. `EMULATE=10 npm run watch-process thing` to run 10 clients side-by-side
launcher.execute(bootstrap, {
  numClients: process.env.EMULATE ? parseInt(process.env.EMULATE) : 1,
  moduleURL: import.meta.url,
});
