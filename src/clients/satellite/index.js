import os from 'node:os';
import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { launcher, loadConfig } from '@soundworks/helpers/node.js';
import { execSync } from 'node:child_process';


import ClientPluginFilesystem from '@soundworks/plugin-filesystem/client.js';
import ClientPluginMixing from '@soundworks/plugin-mixing/client.js';

import { Scheduler } from '@ircam/sc-scheduling';
import SynthesisEngine from './SynthesisEngine.js';
import LED from './Led.js';

import {
  AudioContext,
  GainNode,
} from 'node-web-audio-api';


import { AudioBufferLoader } from '@ircam/sc-loader';
// import { performance } from 'node:perf_hooks';


/*
TODO:

- load from local if file exists
*/

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

const DEBUG = false;

async function bootstrap() {
  const audioContext = new AudioContext();
  const audioBufferLoader = new AudioBufferLoader(audioContext);
  const hostname = os.hostname();

  const config = loadConfig(process.env.ENV, import.meta.url);
  const client = new Client(config);
  launcher.register(client);

  client.pluginManager.register('filesystem-soundbank', ClientPluginFilesystem, {});
  client.pluginManager.register('filesystem-analysis', ClientPluginFilesystem, {});
  client.pluginManager.register('mixing', ClientPluginMixing, {
    role: 'track',
    audioContext,
    label: hostname,
  });

  await client.start();

  console.log('loading....')

  const filesystemSoundbank = await client.pluginManager.get('filesystem-soundbank');

  const controllers = await client.stateManager.getCollection('controller');
  const global = await client.stateManager.attach('global');

  const mixing = await client.pluginManager.get('mixing');

  let group = null;
  let groupSource = null;

  // load buffers
  const buffers = {};
  for (const fileNode of filesystemSoundbank.getTree().children) {
    // const { useHttps, serverAddress, port } = config.env;
    // const url = `${useHttps ? 'https' : 'http'}://${serverAddress}:${port}${fileNode.url}`;
    // const path = `${config.env.serverAddress}/${fileNode.url}`;
    // console.log(fileNode);
    const buffer = await audioBufferLoader.load(fileNode.path);
    buffers[fileNode.name] = buffer;
  }

  filesystemSoundbank.onUpdate(async updates => {
    for (const event of updates.events) {
      if (event.type === 'create') {
        // const { useHttps, serverAddress, port } = config.env;
        // const url = `${useHttps ? 'https' : 'http'}://${serverAddress}:${port}${event.node.url}`;
        const buffer = await audioBufferLoader.load(event.node.path);
        buffers[event.node.name] = buffer;
      }
      if (event.type === 'delete') {
        delete buffers[event.node.name];
      }
    }
  });

  // synthesis
  const scheduler = new Scheduler(() => audioContext.currentTime);
  const synthesisEngine = new SynthesisEngine(audioContext);

  scheduler.add(synthesisEngine.play, audioContext.currentTime);

  // audio path
  const outputNode = new GainNode(audioContext);
  synthesisEngine.connect(outputNode);
  outputNode.connect(mixing.input);

  // led
  const isEmulated = !hostname.startsWith('dotpi-');
  const led = new LED({ emulated: isEmulated, verbose: false });
  led.init(audioContext, scheduler, outputNode);

  global.onUpdate(updates => {
    if ('ledColor' in updates) {
      led.baseColor = updates.ledColor;
    }
    if ('ledIntensity' in updates) {
      led.intensityFactor = updates.ledIntensity;
    }
  }, true);

  // updates
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

  const satellite = await client.stateManager.create('satellite', { name: os.hostname() });
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
            await groupSource.detach();
          }
          if (value) {
            group = await client.stateManager.attach('group', value);
            groupSource = await client.stateManager.attach('source', group.get('sourceState'));
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
            groupSource.onUpdate(updates => {
              if ('sourceData' in updates) {
                if (updates.sourceData) {
                  const buffer = buffers[updates.sourceData.name];
                  const analysisData = JSON.parse(updates.sourceData.data);
                  // const kdTree = createKDTree.deserialize(analysisData.serializedTree);
                  synthesisEngine.setBuffer(buffer);
                  synthesisEngine.setSearchSpace(analysisData.serializedTree, analysisData.times);
                }
              }
            }, true)
            group.onDetach(() => {
              group = null;
              synthesisEngine.playing = false;
            });
            groupSource.onDetach(() => {
              groupSource = null;
            });
          } else {
            group = null;
            groupSource = null;
            synthesisEngine.playing = false;
          }
          // console.log("after", group);
          break;
        }
      }
    })
  });

  console.log(`Hello ${client.config.app.name}!`);
}

// The launcher allows to fork multiple clients in the same terminal window
// by defining the `EMULATE` env process variable
// e.g. `EMULATE=10 npm run watch-process thing` to run 10 clients side-by-side
launcher.execute(bootstrap, {
  numClients: process.env.EMULATE ? parseInt(process.env.EMULATE) : 1,
  moduleURL: import.meta.url,
});
