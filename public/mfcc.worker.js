import Mfcc from './Mfcc.js';

addEventListener('message', e => {
  const {type, data} = e.data;

  switch (type) {
    case 'message': {
      // ping / pong message to ensure initialization
      postMessage({ type: 'message', data });
      break;
    }
    case 'analyze-calibration': {
      console.log('begin analysis');
      const init = data.analysisInitData;
      const analyzer = new Mfcc(init.mfccBands, init.mfccCoefs, init.mfccMinFreq, init.mfccMaxFreq, init.frameSize, init.sampleRate);
      const [mfccFrames, times, means, std, minRms, maxRms] = analyzer.computeBufferMfcc(data.buffer, init.hopSize);
      postMessage({
        type,
        data: {
          means,
          std,
          minRms,
          maxRms,
        }
      });
      break;
    }
    case 'analyze-recording': {
      console.log('begin analysis');
      const init = data.analysisInitData;
      const analyzer = new Mfcc(init.mfccBands, init.mfccCoefs, init.mfccMinFreq, init.mfccMaxFreq, init.frameSize, init.sampleRate);
      const [mfccFrames, times, means, std, minRms, maxRms] = analyzer.computeBufferMfcc(data.buffer, init.hopSize);
      postMessage({
        type,
        data: {
          means,
          std,
          minRms,
          maxRms,
          bufferParams: data.bufferParams,
          buffer: data.buffer,
        },
      });
      break;
    }
    default: {
      console.log('mfcc.worker: Unhandled message type', type);
      break;
    }
  }
});
