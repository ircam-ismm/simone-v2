import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import launcher from '@soundworks/helpers/launcher.js';

import { html, render } from 'lit';
import '../components/sw-audit.js';

import pluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import pluginFilesystem from '@soundworks/plugin-filesystem/client.js';

import { AudioBufferLoader } from '@ircam/sc-loader';
import { Scheduler } from '@ircam/sc-scheduling'; 

import Mfcc from '../utils/Mfcc.js';
import mfccWorkerString from '../utils/mfcc.worker.js?inline';

import '@ircam/sc-components/sc-toggle.js';
import '@ircam/sc-components/sc-separator.js';
import '@ircam/sc-components/sc-button.js';
import '@ircam/sc-components/sc-text.js';
import '@ircam/sc-components/sc-icon.js';
import '@ircam/sc-components/sc-select.js';
import '@ircam/sc-components/sc-slider.js';
import '@ircam/sc-components/sc-transport.js';
import '@ircam/sc-components/sc-record.js';
import '@ircam/sc-components/sc-signal.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

const config = window.SOUNDWORKS_CONFIG;

const audioContext = new AudioContext(); 

const audioBufferLoader = new AudioBufferLoader({});

const analysisParams = {
  frameSize: 1024,
  hopSize: 512,
  sampleRate: audioContext.sampleRate,
  mfccBands: 24,
  mfccCoefs: 12,
  mfccMinFreq: 50,
  mfccMaxFreq: 8000,
};

async function main($container) {
  const client = new Client(config);

  client.pluginManager.register('platform-init', pluginPlatformInit, { audioContext });
  client.pluginManager.register('filesystem-soundbank', pluginFilesystem, {});
  client.pluginManager.register('filesystem-calibration', pluginFilesystem, {});

  launcher.register(client, {
    initScreensContainer: $container,
    reloadOnVisibilityChange: false,
  });

  await client.start();

  const filesystemSoundbank = await client.pluginManager.get('filesystem-soundbank');
  filesystemSoundbank.onUpdate(() => renderApp());

  const filesystemCalibration = await client.pluginManager.get('filesystem-calibration');
  filesystemCalibration.onUpdate(() => renderApp());

  const global = await client.stateManager.attach('global');
  const controller = await client.stateManager.create('controller');

  // microphone
  let micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseReduction: false, autoGainControl: false }, video: false });
    console.log('access to microphone granted');
  } catch (err) {
    console.log('ERROR: could not access microphone');
    console.log(err);
  }

  const micNode = new MediaStreamAudioSourceNode(audioContext, {mediaStream: micStream});

  // audio path
  const analyser = new AnalyserNode(audioContext, {
    fftSize: analysisParams.frameSize,
  });

  micNode.connect(analyser);


  // calibration
  const mediaRecorder = new MediaRecorder(micStream);
  const fileReader = new FileReader();
  let recordedBuffer = null;
  let calibrationLoaded = '';

  mediaRecorder.addEventListener('dataavailable', e => {
    console.log("data media recorder")
    if (e.data.size > 0) {
      fileReader.readAsArrayBuffer(e.data);
    }
  });

  fileReader.addEventListener('loadend', async () => {
    recordedBuffer = await audioContext.decodeAudioData(fileReader.result);
    renderApp();
  });

  const workerBlob = new Blob([mfccWorkerString], { type: 'text/javascript' });
  const workerUrl = URL.createObjectURL(workerBlob);
  const calibrationWorker = new Worker(workerUrl);

  calibrationWorker.postMessage({
    type: 'message',
    data: "worker says hello",
  });

  calibrationWorker.addEventListener('message', e => {
    const { type, data } = e.data;
    if (type === "message") {
      console.log(data);
    }
    if (type === "analyze-target") {
      // analysisEngine.setNorm(data.means, data.std, data.minRms, data.maxRms);
      console.log('maxRms', data.maxRms);
      means = data.means;
      std = data.std;
      minRms = data.minRms;
      maxRms = data.maxRms;
      // save in file 
      const now = new Date();
      const filename = `calibration-${now.getFullYear()}${now.getMonth()}${now.getDate()}-${now.getHours()}${now.getMinutes()}${now.getSeconds()}.txt`;
      filesystemCalibration.writeFile(filename, JSON.stringify(data));
      recordedBuffer = null;
      //update render
      calibrationLoaded = filename;
      const $selectCalibration = document.getElementById('select-calibration');
      $selectCalibration.value = filename;
      renderApp();
    }
  });

  // audio analysis 
  // const scheduler = new Scheduler(() => audioContext.currentTime);
  const mfcc = new Mfcc(analysisParams);
  const analysisBuffer = new Float32Array(analysisParams.frameSize);
  for (let i = 0; i < analysisBuffer.length; i++) {
    analysisBuffer[i] = 0;
  }
  let analysisBufferIndex = 0;
  const processor = audioContext.createScriptProcessor(analysisParams.hopSize);
  let active = false;
  let means = [];
  let std = [];
  for (let i = 0; i < analysisParams.mfccCoefs; i++) {
    means.push(0.);
    std.push(1.);
  }
  let minRms = 0;
  let maxRms = 1;

  processor.addEventListener('audioprocess', event => {
    const $signalMic = document.getElementById('signal-mic');
    if (active) {
      const inputBuffer = event.inputBuffer;
      const inputData = inputBuffer.getChannelData(0);

      for (let i = 0; i < analysisBuffer.length - inputData.length; i++) {
        analysisBuffer[i] = analysisBuffer[i + inputData.length];
      } 
      for (let i = 0; i < inputData.length; i++) {
        analysisBuffer[i + analysisBuffer.length - inputData.length] = inputData[i]; 
      } 

      const targetMfcc = mfcc.get(analysisBuffer);
      for (let j = 0; j < analysisParams.mfccCoefs; j++) {
        targetMfcc[j] = (targetMfcc[j] - means[j]) / std[j];
      }
      let targetRms = 0;
      for (let j = 0; j < analysisBuffer.length; j++) {
        targetRms += analysisBuffer[j] ** 2;
      }
      targetRms = Math.sqrt(targetRms / analysisBuffer.length);
      if (maxRms - minRms === 0) {
        targetRms = 0;
      } else {
        targetRms = (targetRms - minRms) / (maxRms - minRms);
      }
      targetRms = Math.max(Math.min(targetRms, 1), 0);

      controller.set({ analysisData: [targetMfcc, targetRms] });

      $signalMic.value = {
        time: audioContext.currentTime,
        data: targetRms,
      }
    }
  });

  micNode.connect(processor);

  // class AnalysisEngine {
  //   constructor() {
  //     this.active = false;

  //     this.targetData = new Float32Array(analysisParams.frameSize);
  //     this.period = analysisParams.hopSize/analysisParams.sampleRate;

  //     this.means = [];
  //     this.std = [];
  //     for (let i = 0; i < analysisParams.mfccCoefs; i++) {
  //       this.means.push(0.);
  //       this.std.push(1.);
  //     }
  //     this.minRms = 0;
  //     this.maxRms = 1;

  //     this.tick = this.tick.bind(this);
  //   }

  //   setNorm(meansMfcc, stdMfcc, minRms, maxRms) {
  //     this.means = meansMfcc;
  //     this.std = stdMfcc;
  //     this.minRms = minRms;
  //     this.maxRms = maxRms;
  //   }

  //   setPeriod(period) {
  //     this.period = period;
  //   }

  //   tick(currentTime) {
  //     currentTime = Math.max(currentTime, audioContext.currentTime);
  //     const $signalMic = document.getElementById('signal-mic');

  //     if (this.active) {
  //       analyser.getFloatTimeDomainData(this.targetData);
  //       const targetMfcc = mfcc.get(this.targetData);
  //       for (let j = 0; j < analysisParams.mfccCoefs; j++) {
  //         targetMfcc[j] = (targetMfcc[j] - this.means[j]) / this.std[j];
  //       }
  //       let targetRms = 0;
  //       for (let j = 0; j < this.targetData.length; j++) {
  //         targetRms += this.targetData[j] ** 2;
  //       }
  //       targetRms = Math.sqrt(targetRms / this.targetData.length);
  //       console.log(targetRms, this.targetData);
  //       if (this.maxRms - this.minRms === 0) {
  //         targetRms = 0;
  //       } else {
  //         targetRms = (targetRms - this.minRms) / (this.maxRms - this.minRms);
  //       }
  //       targetRms = Math.max(Math.min(targetRms, 1), 0);

  //       controller.set({ analysisData: [targetMfcc, targetRms] });
        
  //       $signalMic.value = {
  //         time: audioContext.currentTime,
  //         data: targetRms,
  //       }
  //     }
  //     return currentTime + this.period;
  //   }
  // }

  // const analysisEngine = new AnalysisEngine();

  // scheduler.add(analysisEngine.tick, audioContext.currentTime);

  // groups 
  const groups = await client.stateManager.getCollection('group');
  groups.onAttach(() => renderApp());
  groups.onUpdate(() => renderApp());
  groups.onDetach(() => renderApp());

  const satellites = await client.stateManager.getCollection('satellite');
  satellites.onAttach(() => renderApp());
  satellites.onUpdate(() => renderApp());
  satellites.onDetach(() => renderApp());

  // updates/subscribe
  controller.onUpdate(updates => {
    Object.entries(updates).forEach(([key, value]) => {
      switch (key) {
        case 'calibrationFileRead': {
          calibrationLoaded = value.filename;
          const data = JSON.parse(value.data);
          means = data.means;
          std = data.std;
          minRms = data.minRms;
          maxRms = data.maxRms;
          break;
        }
      }
    });
    renderApp();
  });

  // presets

  // render
  function renderApp() {
    const synthesisParams = ['volume', 'detune', 'grainPeriod', 'grainDuration', 'randomizer'];
    const $selectCalibration = document.getElementById('select-calibration');
    let loadCalibrationBtnDisabled = true;
    if ($selectCalibration) {
      loadCalibrationBtnDisabled = !$selectCalibration.value || $selectCalibration.value === calibrationLoaded;
    }
    
    render(html`
      <div class="controller-layout">
        <header>
          <h1>${client.config.app.name} | ${client.role}</h1>
          <sw-audit .client="${client}"></sw-audit>
        </header>
        <!-- microphone and calibration -->
        <div style="
          border-bottom: solid 2px var(--sw-lighter-background-color);
          width: 100%;
          height: 100px;
          display: flex;
          flex-direction: row;
        ">
          <div style="
            margin-left: 10px;
            margin-right: 10px;
            display: flex;
            flex-direction: column;
            align-items: center;
          ">
            <h2>activate mic</h2>
            <sc-record
              style="
                height: 50px;
                width: 50px;
              "
              @change=${e => active = e.detail.value}
            ></sc-record>
          </div>
          <sc-signal
            style="
              height: 96px;
              width: 300px;
              margin-top: 2px;
              margin-right: 50px;
              background-color: var(--sw-medium-background-color);
              color: #ffffff;
            "
            duration=2
            min=${0 - 0.02}
            max=${1 + 0.02}
            .colors=${['#ffffff']}
            .lineWidth=${3}
            id="signal-mic"
          ></sc-signal>
          <div>
            <h2>calibration</h2>
            <sc-record
              @change=${e => {
                e.detail.value ? mediaRecorder.start() : mediaRecorder.stop();
              }}
            ></sc-record>
            <sc-button
              style="
                width: 100px;
              "
              ?disabled=${recordedBuffer === null}
              @release=${e => {
                calibrationWorker.postMessage({
                  type: 'analyze-target',
                  data: {
                    analysisInitData: analysisParams,
                    buffer: recordedBuffer.getChannelData(0),
                  }
                });
              }}
            >compute</sc-button>
            <sc-select
              id="select-calibration"
              placeholder="select calibration file"
              options=${JSON.stringify(filesystemCalibration.getTree().children.map(e => e.name))}
              @change=${e => renderApp()}
            ></sc-select>
            <sc-button
              style="
                width: 70px;
              "
              @release=${e => {
                const selectedFile = $selectCalibration.value;
                if (selectedFile) {
                  controller.set({loadCalibrationFile: selectedFile});
                }
              }}
              ?disabled=${loadCalibrationBtnDisabled}
            >load</sc-button>
            <p>loaded: ${calibrationLoaded}</p> 
          </div>
          
        </div>
        <!-- groups and controls -->
        <div style="
          display: flex;
          flex-direction: row;
          height: 100%
        ">
          <!-- group setup and client list -->
          <div style="
            flex-grow: 1;
            padding: 10px;
            overflow: hidden;
          ">
            <h2>groups</h2>
            <div style="
              display: flex;
              flex-direction: column;
            ">
            ${groups.map(group => {
              return html`
                <div style="
                  display: flex;
                  flex-direction: row;
                ">
                  <sc-text
                    style="
                      width: 100%;
                    "
                    editable
                    @change=${e => group.set({ name: e.detail.value })}
                  >${group.get('name')}</sc-text>
                  <input 
                    type="color"
                    style="
                      margin-left: 0px;
                      height: 30px;
                      width: 30px;
                      cursor: pointer;
                      border: solid 1px var(--sw-lighter-background-color);
                      background-color: var(--sw-light-background-color);
                      flex-shrink: 0;
                    "
                    value=${group.get('color')}
                    @input=${e => group.set({color: e.target.value})}
                  />
                  <sc-icon
                    style="
                      flex-shrink: 0;
                    "
                    type="delete"
                    @input=${e => global.set({deleteGroup: group.id})}
                  ></sc-icon>
                </div>
              `;
            })}
              <sc-button
                style="
                  width: 100%;
                "
                @release=${e => global.set({ createGroup: true })}
              >+</sc-button>
            </div>
            <h2>clients</h2>
            <div>
              ${satellites.map(satellite => {
                const group = groups.find(group => group.id === satellite.get('group'));
                let groupName = null;
                let color = 'black'
                if (group) {
                  color = group.get('color');
                  groupName = group.get('name');
                }
                return html`
                  <div style="
                    display: flex; 
                    flex-direction: row;
                    align-items: center;
                  ">
                    <sc-text style="
                      width: 100%;
                    "
                    >${satellite.get('name')}</sc-text>
                    <sc-button style="
                      width: 50px;
                      flex-shrink: 0;
                    "
                    >reboot</sc-button>
                    <sc-select 
                      style="
                        flex-shrink: 0;
                      "
                      options=${JSON.stringify(groups.get('name')) }
                      placeholder="select group"
                      value=${groupName}
                      @change=${e => {
                        const groupName = e.detail.value;
                        const group = groups.find(group => group.get('name') === groupName);
                        let groupId = group ? group.id : null;  
                        satellite.set({group: groupId});
                      }}
                    ></sc-select>
                    <div style="
                      margin-left: 2px;
                      width: 15px;
                      height: 15px;
                      border-radius: 100px;
                      flex-shrink: 0;
                      background-color: ${color}
                    "
                    ></div>
                  </div>
                `
              })}
            </div>
          </div>

          <sc-separator direction="row"></sc-separator>

          <!-- controls -->
          <div style="
            flex-grow: 2;
            overflow: hidden;
            padding: 20px;
            display: flex;
            align-content: flex-start;
            flex-wrap: wrap;
          ">
              ${groups.map(group => {
                return html`
                  <div style="  
                    height: 300px; 
                    width: 400px;
                    border: solid 2px var(--sw-lighter-background-color);
                    border-left: solid 5px ${group.get('color')};
                    padding: 10px;
                    margin: 5px;
                  "
                  >
                    <div style="
                      display: flex;
                      flex-direction: row;
                      justify-content: space-between;
                      align-items: center;
                      margin-bottom: 20px;
                    ">
                      <div>
                        <h2 style="
                          margin: 0;
                          overflow: hidden;
                        ">${group.get('name')}</h2>
                        <p>n clients: ${satellites.filter(e => e.get('group') === group.id).length}</p>
                      </div>
                      <sc-transport
                        style="
                          height: 40px;
                        "
                        .buttons=${["play", "stop"]}
                        @change=${e => group.set({playing: e.detail.value === 'play' })}
                        value=${group.get('playing') ? 'play' : 'stop'}
                      ></sc-transport>
                    </div>
                    <div style="
                      display: flex;
                      flex-direction: row;
                      justify-content: space-between;
                    ">
                      <p>source</p>
                      <sc-select
                        style="
                          width: 280px;
                        "
                        value=${group.get('sourceName')}
                        options=${JSON.stringify(filesystemSoundbank.getTree().children.map(e => e.name))}
                        placeholder="select source"
                        @change=${e => group.set({sourceName: e.detail.value})}
                      ></sc-select>
                    </div>
                    ${synthesisParams.map(param => {
                      const schema = group.getSchema();
                      return html`
                        <div style="
                          display: flex;
                          flex-direction: row;
                          justify-content: space-between;
                          margin-top: 5px;
                        ">
                          <p>${param}</p>
                          <sc-slider
                            number-box
                            min=${schema[param].min}
                            max=${schema[param].max}
                            value=${group.get(param)}
                            @input=${e => {
                              const update = {}
                              update[param] = e.detail.value;
                              group.set(update);
                            }}
                          ></sc-slider>
                        </div>
                      `
                    })}
                  </div>
                `
              })}
          </div>
        </div>
      </div>
    `, $container);
  }

  renderApp();
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate')) || 1,
  width: '50%',
});
