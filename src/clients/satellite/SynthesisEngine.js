import {
  AudioBufferSourceNode,
  GainNode,
} from 'node-web-audio-api'; 

import { Worker } from 'worker_threads';
import { dbtoa } from '@ircam/sc-utils';


class SynthesisEngine {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.playing = false;

    this.detune = 0;
    this.grainPeriod = 0.1;
    this.grainDuration = 0.25;
    this._randomizer = 1;

    this.targets = null;
    this.playRms = 0;

    this.output = new GainNode(this.audioContext);

    this.searchWorker = new Worker('./src/clients/satellite/search.worker.js');
    this.searchWorker.on('message', e => {
      const { type, data } = e;
      if (type === 'target') {
        const { targets, rms } = data;
        this.targets = targets;
        this.playRms = rms;

      }
    });

    this.play = this.play.bind(this);
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
    const now = this.audioContext.currentTime;
    this.output.gain.setTargetAtTime(dbtoa(value), now, 0.01);
  }

  set randomizer(value) {
    this._randomizer = Math.floor(value);
  }

  setTarget(x) {
    this.currGrainMfcc = x[0];
    this.currGrainRms = x[1];
    if (this.kdTree) {
      this.searchWorker.postMessage({
        type: 'target',
        data: {
          mfcc: this.currGrainMfcc,
          rms: this.currGrainRms,
          randomizer: this._randomizer,
        }
      });
    }
  }

  connect(dest) {
    this.output.connect(dest);
  }

  play(time) {
    time = Math.max(time, this.audioContext.currentTime);
    if (this.playing && this.targets) {
      const randK = Math.floor(Math.random() * this.targets.length);
      const target = this.targets[randK];
      let timeOffset = this.times[target];
      timeOffset = Math.min(timeOffset, this.buffer.duration - this.grainDuration);

      const rand = Math.random() * 0.004;
      const now = time + rand;

      const env = new GainNode(this.audioContext);
      env.connect(this.output);
      env.gain.value = 0;
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(this.playRms, now + (this.grainDuration / 2));
      env.gain.linearRampToValueAtTime(0, now + this.grainDuration);

      const source = new AudioBufferSourceNode(this.audioContext);
      source.connect(env);
      source.buffer = this.buffer;
      source.detune.value = this.detune * 100;

      //weird error where timeoffset is sometimes undefined here
      try {
        source.start(now, timeOffset);
        source.stop(now + this.grainDuration);
      } catch (error) {
        console.log('error', now, timeOffset, this.grainDuration)
        // console.log(error)
      }
      this.targets = null;
    }
    return time + this.grainPeriod;
  }
}

export default SynthesisEngine;