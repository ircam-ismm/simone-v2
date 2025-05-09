import '@soundworks/helpers/polyfills.js';
import { Client, Context } from '@soundworks/core/client.js';

import launcher from '@soundworks/helpers/launcher.js';

import { html, nothing, render } from 'lit';
import '../components/sw-audit.js';

import ClientPluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import ClientPluginFilesystem from '@soundworks/plugin-filesystem/client.js';
import ClientPluginMixing from '@soundworks/plugin-mixing/client.js';

import { AudioBufferLoader } from '@ircam/sc-loader';
import { Scheduler } from '@ircam/sc-scheduling';

import Mfcc from '../../../public/Mfcc.js';

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
import '@ircam/sc-components/sc-tab.js';
import '@ircam/sc-components/sc-filetree.js';
import '@ircam/sc-components/sc-waveform.js';
import '@ircam/sc-components/sc-dragndrop.js';
import '@ircam/sc-components/sc-midi.js';
import '@ircam/sc-components/sc-color-picker.js';
import '@soundworks/plugin-mixing/components.js';


// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`


const config = window.SOUNDWORKS_CONFIG;
const audioContext = new AudioContext();

const audioBufferLoader = new AudioBufferLoader(audioContext);

const analysisParams = {
  frameSize: 1024,
  hopSize: 2048,
  displayFrame: 512,
  sampleRate: audioContext.sampleRate,
  mfccBands: 24,
  mfccCoefs: 12,
  mfccMinFreq: 50,
  mfccMaxFreq: 8000,
};

async function main($container) {
  const client = new Client(config);

  client.pluginManager.register('platform-init', ClientPluginPlatformInit, { audioContext });
  client.pluginManager.register('filesystem-soundbank', ClientPluginFilesystem, {});
  client.pluginManager.register('filesystem-calibration', ClientPluginFilesystem, {});
  client.pluginManager.register('mixing', ClientPluginMixing, { role: 'controller' });

  launcher.register(client, {
    initScreensContainer: $container,
    reloadOnVisibilityChange: false,
  });

  await client.start();

  const filesystemSoundbank = await client.pluginManager.get('filesystem-soundbank');
  filesystemSoundbank.onUpdate(() => renderApp());

  const filesystemCalibration = await client.pluginManager.get('filesystem-calibration');
  filesystemCalibration.onUpdate(() => renderApp());

  const mixing = await client.pluginManager.get('mixing');

  const global = await client.stateManager.attach('global');
  const controller = await client.stateManager.create('controller');


  let inputMode = 'realtime';

  const analysisWorker = new Worker('./mfcc.worker.js', { type: 'module' });
  analysisWorker.postMessage({
    type: 'message',
    data: "worker says hello",
  });

  analysisWorker.addEventListener('message', e => {
    const { type, data } = e.data;
    if (type === "message") {
      console.log(data);
    }

    if (type === "analyze-calibration") {
      // analysisEngine.setNorm(data.means, data.std, data.minRms, data.maxRms);
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
    if (type === 'analyze-recording') {
      // recreate buffer
      const buffer = new AudioBuffer({
        length: data.bufferParams.length,
        sampleRate: data.bufferParams.sampleRate
      });
      const bufferData = buffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        bufferData[i] = data.buffer[i];
      }
      // update engine
      const {means, std, minRms, maxRms} = data;
      const norms = {
        means,
        std,
        minRms,
        maxRms
      };
      analyzerEngine.buffer = buffer;
      analyzerEngine.setNorm(norms);
      analyzerEngine.setLoopLimits(0, buffer.duration);
      // analyzerEngine.start();
      // update waveform
      loadedTargetBuffer = buffer;
      renderApp();
    }
  });

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

  const delayNode = new DelayNode(audioContext);

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


  // audio analysis
  const { mfccBands, mfccCoefs, mfccMinFreq, mfccMaxFreq, frameSize, sampleRate } = analysisParams;
  const mfcc = new Mfcc(mfccBands, mfccCoefs, mfccMinFreq, mfccMaxFreq, frameSize, sampleRate);
    // realtime
  const analysisBuffer = new Float32Array(analysisParams.frameSize);
  for (let i = 0; i < analysisBuffer.length; i++) {
    analysisBuffer[i] = 0;
  }
  let analysisBufferIndex = 0;
  const processor = audioContext.createScriptProcessor(analysisParams.hopSize);
  const displaySignalProcessor = audioContext.createScriptProcessor(analysisParams.displayFrame);

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
    if (active) {
      const inputBuffer = event.inputBuffer;
      const inputData = inputBuffer.getChannelData(0);

      // in case hop size is > than frame size we do not use all data
      if (analysisParams.hopSize < analysisParams.frameSize) {
        for (let i = 0; i < analysisBuffer.length - inputData.length; i++) {
          analysisBuffer[i] = analysisBuffer[i + inputData.length];
        }
        for (let i = 0; i < inputData.length; i++) {
          analysisBuffer[i + analysisBuffer.length - inputData.length] = inputData[i];
        }
      } else {
        for (let i = 0; i < analysisBuffer.length; i++) {
          analysisBuffer[i] = inputData[i];
        }
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
    }
  });

  displaySignalProcessor.addEventListener('audioprocess', event => {
    const $signalMic = document.getElementById('signal-mic');
    if (active) {
      const inputBuffer = event.inputBuffer;
      const inputData = inputBuffer.getChannelData(0);
      let rms = 0;
      for (let k = 0; k < inputData.length; k++) {
        rms += inputData[k] ** 2;
      }
      rms = Math.sqrt(rms / inputData.length);
      $signalMic.value = {
        time: audioContext.currentTime,
        data: rms,
      }
    }
  });


  micNode.connect(delayNode);
  delayNode.connect(processor);
  delayNode.connect(displaySignalProcessor);
  processor.connect(audioContext.destination);
  displaySignalProcessor.connect(audioContext.destination);

  class AnalyzerEngine {
    constructor(period, frameSize) {
      this.period = period;
      this.frameSize = Math.pow(2, Math.round(Math.log2(frameSize))); // clamp to nearest power of 2

      this.buffer = null;

      this.active = false;
      this.periodRand = 0.004;

      this.tick = this.tick.bind(this);
    }

    setNorm(norms) {
      this.means = norms.means;
      this.std = norms.std;
      this.minRms = norms.minRms;
      this.maxRms = norms.maxRms;
    }

    setLoopLimits(startTime, endTime) {
      if (endTime - startTime > 0) {
        this.startTime = startTime;
        this.endTime = endTime;
      }
    }

    start() {
      this.transportTime = this.startTime;
      this.active = true;
    }

    stop() {
      this.active = false;
    }

    tick(time) {
      time = Math.max(time, audioContext.currentTime);

      if (this.active && this.buffer) {
        const bufferData = this.buffer.getChannelData(0);
        const idx = Math.floor(this.transportTime * this.buffer.sampleRate);
        const iMin = Math.max(0, idx - this.frameSize / 2);
        const iMax = idx + this.frameSize / 2;
        const grain = bufferData.slice(iMin, iMax);
        // compute mfcc
        const grainMfcc = mfcc.get(grain);
        for (let j = 0; j < 12; j++) {
          grainMfcc[j] = (grainMfcc[j] - this.means[j]) / this.std[j];
        }
        //compute rms
        let grainRms = 0;
        for (let j = 0; j < grain.length; j++) {
          grainRms += grain[j] ** 2;
        }
        grainRms = Math.sqrt(grainRms / grain.length);
        if (this.maxRms === 0) {
          grainRms = 0;
        } else {
          grainRms = (grainRms - this.minRms) / (this.maxRms - this.minRms);
        }
        grainRms = Math.max(Math.min(grainRms, 1), 0);

        controller.set({ analysisData: [grainMfcc, grainRms] });

        const $waveform = document.querySelector('#target-waveform');
        $waveform.cursorPosition = this.transportTime;
      }

      let period = this.period;
      const transportTime = this.transportTime;
      const loopDuration = this.endTime - this.startTime;

      this.transportTime += this.period;

      if (this.transportTime < this.startTime) {
        while (this.transportTime < this.startTime) {
          this.transportTime += loopDuration;
        }
      }
      if (this.transportTime > this.endTime) {
        this.transportTime = this.startTime;
        period = this.endTime - transportTime;
        // while (this.transportTime > this.endTime) {
        //   this.transportTime -= loopDuration;
        // }
      }

      return time + period;
    }
  }

  const scheduler = new Scheduler(() => audioContext.currentTime);
  const analyzerEngine = new AnalyzerEngine(analysisParams.hopSize/audioContext.sampleRate, analysisParams.frameSize);
  scheduler.add(analyzerEngine.tick, audioContext.currentTime);

  let loadedTargetBuffer = null;

  function loadTargetBuffer(buffer) {
    // analyze
    analysisWorker.postMessage({
      type: 'analyze-recording',
      data: {
        analysisInitData: analysisParams,
        buffer: buffer.getChannelData(0),
        bufferParams: {
          length: buffer.length,
          sampleRate: buffer.sampleRate
        }
      }
    });
  }

  // groups
  const groups = await client.stateManager.getCollection('group');
  groups.onAttach(() => renderApp());
  groups.onUpdate(() => renderApp());
  groups.onDetach(() => renderApp());

  const satellites = await client.stateManager.getCollection('satellite');
  satellites.onAttach(() => {
    satellites.sort((a, b) => a.get('name') < b.get('name') ? -1 : 1)
    renderApp()
  });
  satellites.onUpdate(() => {
    satellites.sort((a, b) => a.get('name') < b.get('name') ? -1 : 1)
    renderApp()
  });
  satellites.onDetach(() => {
    satellites.sort((a, b) => a.get('name') < b.get('name') ? -1 : 1)
    renderApp()
  });

  const deleteAllGroups = () => {
    groups.forEach(group => {
      global.set({ deleteGroup: group.id });
    });
  }

  const createSingleGroup = () => {
    global.set({ createSingleGroup: true });
  }

  const createOneGroupPerClient = () => {
    global.set({ createOneGroupPerClient: true });
  }

  // updates/subscribe
  controller.onUpdate(updates => {
    Object.entries(updates).forEach(async ([key, value]) => {
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
        case 'analysisFileRead': {
          // get url
          const file = filesystemSoundbank.getTree().children.find(e => e.name === value.filename);
          // get buffer
          const buffer = await audioBufferLoader.load(file.url);
          analyzerEngine.buffer = buffer;
          analyzerEngine.setNorm(value.data);
          analyzerEngine.setLoopLimits(0, buffer.duration);
          // analyzerEngine.start();
          // update waveform
          loadedTargetBuffer = buffer;
          renderApp();
          break;
        }
        case 'grainPeriod': {
          groups.forEach(group => {
            group.set({grainPeriod: value});
          });
          break;
        }
        case 'grainDuration': {
          groups.forEach(group => {
            group.set({ grainDuration: value });
          });
          break;
        }
        case 'volume': {
          groups.forEach(group => {
            group.set({ volume: value });
          });
          break;
        }
      }
    });
    renderApp();
  });

  //
  const selectSourcesTimeoutIds = new Set();
  // presets
  const nPresets = 16;
  const presets = global.get('presets');
  let presetMode = 'load';

  function presetButtonCallback(i) {
    switch (presetMode) {
      case 'save': {
        const preset = {}
        groups.getValues().forEach(group => {
          const values = {
            sourceName: group.sourceName,
            volume: group.volume,
            detune: group.detune,
            grainPeriod: group.grainPeriod,
            grainDuration: group.grainDuration,
            randomizer: group.randomizer,
          };
          preset[group.name] = values;
        });
        presets[i] = preset;
        break;
      }
      case 'del':
        delete presets[i];
        break;
      case 'load': {
        const preset = presets[i];
        Object.entries(preset).forEach(([groupName, groupValue]) => {
          const groupState = groups.find(group => group.get('name') === groupName);
          if (groupState) {
            groupState.set(groupValue);
          }
        });
        break;
      }
    }
    global.set({presets});
    renderApp();
  }

  // render
  let showMasterControls = true;

  function renderInputPanel() {
    const now = audioContext.currentTime;
    const $selectCalibration = document.getElementById('select-calibration');
    let loadCalibrationBtnDisabled = true;

    if ($selectCalibration) {
      loadCalibrationBtnDisabled = !$selectCalibration.value || $selectCalibration.value === calibrationLoaded;
    }

    switch (inputMode) {
      case 'realtime': {
        return html`
          <div style="
            margin-right: 10px;
            display: flex;
            flex-direction: column;
            align-items: center;
          ">
            <h2>activate mic</h2>
            <sc-record
              id="realtime-record"
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
              margin-right: 20px;
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
          <div style="
            margin-right: 50px;
          ">
            <h2>delay mic</h2>
            <sc-slider
              min=0
              max=1
              number-box
              value=0
              @input=${e => delayNode.delayTime.setTargetAtTime(e.detail.value, now, 0.02)}
            >
            </sc-slider>
          </div>
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
                analysisWorker.postMessage({
                  type: 'analyze-calibration',
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
        `
        break;
      }
      case 'loop record': {
        return html `
          <div style="
            height: 100%;
            display: flex;
            align-items: center
          ">
            <sc-record
              id="loop-record-record"
              style="
                height: 50px;
                width: 50px;
                margin-right: 10px;
                flex-shrink: 0
              "
              @change=${e => {
                e.detail.value ? mediaRecorder.start() : mediaRecorder.stop();
              }}
            ></sc-record>
          </div>
          <sc-waveform
            style="
              height: 100%;
              flex-shrink: 0
            "
            .buffer=${recordedBuffer}
          ></sc-waveform>
          <sc-button
            style="
              height: 100%;
              width: 50px;
              margin-right: 10px;
              flex-shrink: 0;
            "
            selected
            @release=${e => loadTargetBuffer(recordedBuffer)}
          >
          use ➡
          </sc-button>
          <sc-transport
            id="loop-record-transport"
            style="
              height: 100%;
              flex-shrink: 0;
              margin-right: 10px;
            "
            .buttons=${["play", "stop"]}
            @change=${e => e.detail.value === 'play' ? analyzerEngine.start() : analyzerEngine.stop()}
          ></sc-transport>
          <sc-waveform
            id="target-waveform"
            style="
              height: 100%;
              width: 100%;
              margin-right: 10px;
            "
            selection
            cursor
            .buffer=${loadedTargetBuffer}
            @input=${e => analyzerEngine.setLoopLimits(e.detail.value.selectionStart, e.detail.value.selectionEnd)}
          >
          </sc-waveform>
        `
        break;
      }
      case 'loop load': {
        return html`
          <sc-filetree
            style="
              height: 100%;
              margin-right: 10px;
              flex-shrink: 0;
            "
            value=${JSON.stringify(filesystemSoundbank.getTree())}
            @input=${e => controller.set({ loadAnalysisFile: e.detail.value.name }) }
          >
          </sc-filetree>
          <sc-dragndrop
            style="
              height: 100%;
              width: 200px;
              margin-right: 10px;
              flex-shrink: 0;
            "
            @change=${e => loadTargetBuffer(Object.values(e.detail.value)[0])}
          ></sc-dragndrop>
          <sc-transport
            id="loop-load-transport"
            style="
              height: 100%;
              flex-shrink: 0;
              margin-right: 10px;
            "
            .buttons=${["play", "stop"]}
            @change=${e => e.detail.value === 'play' ? analyzerEngine.start() : analyzerEngine.stop()}
          ></sc-transport>
          <sc-waveform
            id="target-waveform"
            style="
              height: 100%;
              width: 100%;
              margin-right: 10px;
            "
            selection
            cursor
            .buffer=${loadedTargetBuffer}
            @input=${e => analyzerEngine.setLoopLimits(e.detail.value.selectionStart, e.detail.value.selectionEnd)}
          >
          </sc-waveform>
        `
        break;
      }
    }
  }

  function renderApp() {
    const now = audioContext.currentTime;
    const synthesisParams = ['volume', 'detune', 'grainPeriod', 'grainDuration', 'randomizer'];

    render(html`
      <div class="controller-layout">
        <header>
          <h1>${client.config.app.name} | ${client.role}</h1>
          <div>
            <sc-midi></sc-midi>
            <sc-icon
              type="slider"
              @click=${e => {
                const target = document.querySelector('#mixing-wrapper')
                target.style.display = target.style.display !== 'block' ? 'block' : 'none';
              }}
            ></sc-icon>
          </div>
          <sw-audit .client="${client}"></sw-audit>
        </header>
        <div id="mixing-wrapper">
          <sw-plugin-mixing .plugin=${mixing}></sw-plugin-mixing>
        </div>
        <!-- microphone and calibration -->
        <div style="
          border-bottom: solid 2px var(--sw-lighter-background-color);
          width: 100%;
          height: 100px;
          display: flex;
          flex-direction: row;
        ">
          <sc-tab
            style="
              margin-right: 10px;
              flex-shrink: 0;
            "
            orientation=vertical
            value=${inputMode}
            options="${JSON.stringify(['realtime', 'loop record', 'loop load'])}"
            @change=${e => {
              active = false;
              analyzerEngine.stop();
              recordedBuffer = null;
              loadedTargetBuffer = null;
              inputMode = e.detail.value;
              renderApp();
            }}
          ></sc-tab>
          ${renderInputPanel()}
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
                    value=${group.get('name')}
                    @change=${e => group.set({ name: e.detail.value })}
                  ></sc-text>
                  <sc-color-picker
                    style="
                      flex-shrink: 0;
                    "
                    value=${group.get('color')}
                    @input=${e => group.set({ color: e.target.value })}
                  ></sc-color-picker>
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
                  margin-bottom: 10px;
                "
                @release=${e => global.set({ createGroup: true })}
              >+</sc-button>
              <sc-button
                style="
                  width: 100%;
                "
                @release=${e => deleteAllGroups()}
              >delete all groups</sc-button>
              <sc-button
                style="
                  width: 100%;
                "
                @release=${e => {
                  deleteAllGroups();
                  createSingleGroup();
                }}
              >single group</sc-button>
              <sc-button
                style="
                  width: 100%;
                "
                @release=${e => {
                  deleteAllGroups();
                  createOneGroupPerClient();
                }}
              >one group per client</sc-button>
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
                    @release=${e => satellite({reboot: true})}
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
                        console.log(groupId)
                        satellite.set({group: groupId});
                        global.set({saveGroupsSatellitesMap: true});
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
            <h2>led controls</h2>
            <div
              style="
                display: flex;
              "
            >
              <sc-color-picker
                style="
                  margin-right: 10px;
                  flex-shrink: 0;
                "
                value=${global.get('ledColor')}
                @input=${e => global.set({ledColor: e.detail.value})}
              ></sc-color-picker>
              <sc-slider
                id="led-slider"
                style="
                  width: 100%;
                "
                max=10
                number-box
                value=${global.get('ledIntensity')}
                @input=${e => global.set({ ledIntensity: e.detail.value })}
              ></sc-slider>
            </div>
          </div>

          <sc-separator direction="row"></sc-separator>

          <!-- controls -->
          <div>
            <div style="
              margin-top: 10px;
              display: flex;
              flex-direction: row;
            ">
              <h2 style="margin: 10px;">master controls</h2>
              <sc-button
                style="

                  width: 50px;
                "
                ?selected=${showMasterControls}
                @release=${() => {
                  showMasterControls = !showMasterControls
                  renderApp();
                }}
              >show</sc-button>
            </div>
            ${
              showMasterControls
              ? html`
                <div style="
                  display: flex;
                  flex-direction: row;
                  flex-wrap: wrap;
                  padding: 0 10px 5px;
                  border-bottom: solid 2px var(--sw-lighter-background-color);
                ">
                  <div style="
                    margin-right: 12px;
                    display: flex;
                    align-items: flex-end;
                  ">
                    <sc-transport
                      id="groups-transport"
                      style="height: 40px;"
                      .buttons=${["play", "stop"]}
                      @input=${e => groups.set({ playing: e.detail.value === 'play' })}
                      value="stop"
                    ></sc-transport>
                  </div>
                  <div style="
                    margin-right: 10px;
                  ">
                    <p>source</p>
                    <sc-select
                      options=${JSON.stringify(filesystemSoundbank.getTree().children.map(e => e.name))}
                      placeholder="select source"
                      @change=${e => {
                        selectSourcesTimeoutIds.forEach(id => clearTimeout(id));
                        selectSourcesTimeoutIds.clear();
                        const duration = document.querySelector('#select-source-duration').value;

                        if (e.detail.value) {
                          groups.forEach(group => {
                            const timeoutId = setTimeout(() => {
                              group.set({ sourceName: e.detail.value })
                            }, Math.random() * duration * 1000);
                            selectSourcesTimeoutIds.add(timeoutId);
                          });
                        }
                      }}
                    ></sc-select>
                    <sc-number
                      id="select-source-duration"
                      min="0"
                      value="0"
                    ></sc-number>
                  </div>
                  ${synthesisParams.map(param => {
                    const groupsSchema = groups.getDescription();
                    return html`
                      <div
                        style="
                          margin-right: 10px;
                        "
                      >
                        <p>${param}</p>
                        <sc-slider
                          id="master-${param}"
                          style="
                            width: 200px;
                          "
                          number-box
                          min=${groupsSchema[param].min}
                          max=${groupsSchema[param].max}
                          @input=${e => {
                            groups.forEach(group => {
                              const update = {};
                              update[param] = e.detail.value
                              group.set(update);
                            });
                          }}
                        ></sc-slider>
                      </div>
                    `
                  })}
                </div>
              `
              : nothing
            }
            <div style="
              flex-grow: 2;
              overflow: hidden;
              padding: 0 20px;
              display: flex;
              align-content: flex-start;
              flex-wrap: wrap;
            ">
              ${groups.map(group => {
                return html`
                  <div style="
                    height: 320px;
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
                      margin-bottom: 4px;
                    ">
                      <div>
                        <h2 style="
                          margin: 0;
                          overflow: hidden;
                        ">${group.get('name')}</h2>
                        <p>n clients: ${satellites.filter(e => e.get('group') === group.id).length}</p>
                      </div>
                      <sc-transport
                        id="group-${group.get('name')}-transport"
                        style="
                          height: 40px;
                        "
                        .buttons=${["play", "stop"]}
                        @change=${e => group.set({ playing: e.detail.value === 'play' })}
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
                        @change=${e => {
                          if (e.detail.value) {
                            group.set({ sourceName: e.detail.value })
                          }
                        }}
                      ></sc-select>
                    </div>
                    ${synthesisParams.map(param => {
                      const schema = group.getDescription();
                      return html`
                        <div style="
                          display: flex;
                          flex-direction: row;
                          justify-content: space-between;
                          margin-top: 5px;
                        ">
                          <p>${param}</p>
                          <sc-slider
                            id="group-${group.get('name')}-${param}"
                            number-box
                            min=${schema[param].min}
                            max=${schema[param].max}
                            value=${group.get(param)}
                            @input=${e => group.set({ [param]: e.detail.value })}
                          ></sc-slider>
                        </div>
                      `
                    })}
                  </div>
                `
              })}
            </div>
          </div>
          <div
            style="
              width: 100px;
              border-left: solid 2px var(--sw-lighter-background-color);
              display: flex;
              flex-direction: column;
              align-items: center;
            "
          >
            <h2>presets</h2>
            <sc-tab
              style="
                width: 95%;
                height: 100px;
                margin-bottom: 20px;
              "
              orientation="vertical"
              value=${presetMode}
              options="${JSON.stringify(['load', 'save', 'del'])}"
              @change=${e => presetMode = e.detail.value}
            ></sc-tab>
            ${Array(nPresets).fill().map((_, i) => {
              return html`
                <sc-button
                  id="button-preset-${i+1}"
                  style="
                    width: 95%;
                  "
                  .selected=${i+1 in presets}
                  @input=${e => presetButtonCallback(i+1)}
                >${i+1}</sc-button>
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
