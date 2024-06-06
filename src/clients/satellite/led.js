import { Client } from '@soundworks/core/client.js';
import { AnalyserNode } from 'node-web-audio-api';

const ledConfig = {
  role: 'dotpi-led-client',
  app: {
    name: 'dotpi-led',
    clients: {
      'dotpi-led-client': { target: 'node' },
    },
  },
  env: {
    type: 'development',
    port: 9999,
    serverAddress: '127.0.0.1',
    useHttps: false,
    verbose: true, //  process.env.VERBOSE === '1' ? true : false,
  },
};

function hexToRgb(hex, factor) {
  var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: Math.min(parseInt(result[1], 16) * factor, 255),
    g: Math.min(parseInt(result[2], 16) * factor, 255),
    b: Math.min(parseInt(result[3], 16) * factor, 255)
  } : null;
}

export default class LED {
  constructor({
    debug = false,
    verbose = true,
  } = {}) {
    this.debug = debug;
    this.verbose = verbose;
    this.intensityFactor = 1;
    this.baseColor = '#ffffff';
    this.rgb = null;
  }

  async init(audioContext, scheduler, inputNode) {
    console.log(this.debug, ledConfig);

    if (!this.debug) {
      const ledClient = new Client(ledConfig);
      try {
        await ledClient.start();
      } catch (err) {
        console.log(err.message);
      }

      console.log('LED inited');
      this.rgb = await ledClient.stateManager.create('rgb');
      this.rgb.set({ r: 0, g: 0, b: 0 });
    }

    const analyser = new AnalyserNode(audioContext, { fftSize: 4096 });
    const analyserData = new Float32Array(analyser.fftSize);
    inputNode.connect(analyser);

    const engine = currentTime => {
      analyser.getFloatTimeDomainData(analyserData);

      let rms = 0;

      for (let i = 0; i < analyser.fftSize; i++) {
        rms += analyserData[i] ** 2;
      }

      rms /= analyser.fftSize;
      rms = Math.sqrt(rms);

      const inflexionPoint = 0.05;
      const inflexionVal = 240;
      let colorIntensity;

      if (rms < inflexionPoint) {
        colorIntensity = rms * inflexionVal / inflexionPoint
      } else {
        colorIntensity = (255 - inflexionVal) /
          (1 - inflexionPoint) * rms + (inflexionVal - inflexionPoint * 255) / (1 - inflexionPoint);
      }

      colorIntensity = Math.min(colorIntensity, 255) / 255;

      const color = hexToRgb(this.baseColor, this.intensityFactor * colorIntensity);

      if (!this.debug) {
        this.rgb.set(color);
      }

      if (this.verbose) {
        console.log(color);
      }

      return currentTime + analyser.fftSize / audioContext.sampleRate;
      // return currentTime + 0.2;
    }

    scheduler.add(engine, audioContext.currentTime);
  }
}

