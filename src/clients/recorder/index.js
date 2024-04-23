import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import launcher from '@soundworks/helpers/launcher.js';

import pluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import pluginFilesystem from '@soundworks/plugin-filesystem/client.js';

import { html, noChange, render } from 'lit';
import '../components/sw-credits.js';

import toWav from 'audiobuffer-to-wav';

import '@ircam/sc-components/sc-record.js';
import '@ircam/sc-components/sc-transport.js';
import '@ircam/sc-components/sc-button.js';
import '@ircam/sc-components/sc-waveform.js';
import '@ircam/sc-components/sc-text.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

/**
 * Grab the configuration object written by the server in the `index.html`
 */
const config = window.SOUNDWORKS_CONFIG;

/**
 * If multiple clients are emulated you might to want to share some resources
 */
const audioContext = new AudioContext();

async function main($container) {
  /**
   * Create the soundworks client
   */
  const client = new Client(config);

  /**
   * Register some soundworks plugins, you will need to install the plugins
   * before hand (run `npx soundworks` for help)
   */
  // client.pluginManager.register('my-plugin', plugin);
  client.pluginManager.register('platform-init', pluginPlatformInit, { audioContext });
  client.pluginManager.register('filesystem-soundbank', pluginFilesystem);

  /**
   * Register the soundworks client into the launcher
   *
   * The launcher will do a bunch of stuff for you:
   * - Display default initialization screens. If you want to change the provided
   * initialization screens, you can import all the helpers directly in your
   * application by doing `npx soundworks --eject-helpers`. You can also
   * customise some global syles variables (background-color, text color etc.)
   * in `src/clients/components/css/app.scss`.
   * You can also change the default language of the intialization screen by
   * setting, the `launcher.language` property, e.g.:
   * `launcher.language = 'fr'`
   * - By default the launcher automatically reloads the client when the socket
   * closes or when the page is hidden. Such behavior can be quite important in
   * performance situation where you don't want some phone getting stuck making
   * noise without having any way left to stop it... Also be aware that a page
   * in a background tab will have all its timers (setTimeout, etc.) put in very
   * low priority, messing any scheduled events.
   */
  launcher.register(client, { initScreensContainer: $container });

  /**
   * Launch application
   */
  await client.start();

  const filesystemSoundbank = await client.pluginManager.get('filesystem-soundbank');

  let micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseReduction: false, autoGainControl: false }, video: false });
    console.log('access to microphone granted');
  } catch (err) {
    console.log('ERROR: could not access microphone');
    console.log(err);
  }

  const mediaRecorder = new MediaRecorder(micStream);
  const fileReader = new FileReader();

  let recordedBuffer = null;
  let cropStart, cropEnd;
  
  mediaRecorder.addEventListener('dataavailable', e => {
    if (e.data.size > 0) {
      fileReader.readAsArrayBuffer(e.data);
    }
  });

  fileReader.addEventListener('loadend', async e => {
    recordedBuffer = await audioContext.decodeAudioData(fileReader.result);
    cropStart = 0;
    cropEnd = recordedBuffer.duration;
    renderApp();
  });

  let source;

  function transportCallback(e) {
    const state = e.detail.value;
    switch (state) {
      case 'play': 
        if (recordedBuffer) {
          source = new AudioBufferSourceNode(audioContext, {
            buffer: recordedBuffer
          });
          source.connect(audioContext.destination);

          const now = audioContext.currentTime;
          source.start(now, cropStart, cropEnd - cropStart);

          source.addEventListener('ended', e => {
            const $transport = document.querySelector('#transport');
            $transport.value = 'stop';
          })
        }
        break;
      case 'stop':
        if (source) {
          source.stop();
        }
        break;
    }
  }

  async function uploadCallback() {
    const $filename = document.querySelector("#filename");
    const filename = $filename.value;
    const $uploadBtn = document.querySelector("#upload-button");
    if (filename) {
      $uploadBtn.disabled = true;
      //crop 
      const sampleRate = audioContext.sampleRate;
      const nChannels = recordedBuffer.numberOfChannels;

      const startIdx = cropStart*sampleRate;
      const endIdx = cropEnd*sampleRate;
      const croppedBuffer = new AudioBuffer({
        length: endIdx - startIdx,
        numberOfChannels: recordedBuffer.numberOfChannels,
        sampleRate
      });

      const tempArray = new Float32Array(endIdx - startIdx);
      for (let c = 0; c < nChannels; c++) {
        recordedBuffer.copyFromChannel(tempArray, c, startIdx);
        croppedBuffer.copyToChannel(tempArray, c);
      }

      const wavBuffer = toWav(croppedBuffer);
      const recordingBlob = new Blob([wavBuffer]);
      await filesystemSoundbank.writeFile(`${filename}.wav`, recordingBlob);
      $uploadBtn.disabled = false;
    }
  }

  function renderApp() {
    render(html`
      <div style="
        margin: auto 20px;
        display: flex;
        flex-direction: column;
        align-items: center;
      ">
        <div style="
          display: flex;
          flex-direction: column;
        ">
          <div style="
            margin-left: 5%;
            margin-bottom: 5px;
          ">
            <sc-record
              style="
                height: 50px;
                width: 50px
              "
              @change="${e => e.detail.value ? mediaRecorder.start() : mediaRecorder.stop()}"
            ></sc-record>
            <sc-transport
              id="transport"
              style="
                height: 50px;
              "
              .buttons=${["play", "stop"]}
              @change=${transportCallback}
            ></sc-transport>
          </div>
          <sc-waveform
            style="
              width: 90%;
              margin: auto
            "
            .buffer=${recordedBuffer}
            selection
            @change=${e => {
              cropStart = e.detail.value.selectionStart;
              cropEnd = e.detail.value.selectionEnd;
            }}
          ></sc-waveform>
        </div>
        <sc-text
          id="filename"
          style="
            margin-top: 10px;
            width: 90%;
          "
          editable
        >write filename (without suffix)</sc-text>
        <sc-button
          id="upload-button"
          style="
            margin-top: 10px;
            width: 90%;
          "
          @release=${uploadCallback}
        >upload file</sc-button>
      </div>
    `, $container);
  }

  renderApp();
}

// The launcher enables instanciation of multiple clients in the same page to
// facilitate development and testing.
// e.g. `http://127.0.0.1:8000?emulate=10` to run 10 clients side-by-side
launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate')) || 1,
});
