import {parentPort} from 'worker_threads';
import createKDTree from 'static-kdtree';
import Mfcc from '../../public/Mfcc.js';

const frameSize = 1024;
const hopSize = 512;
const mfccBands = 24;
const mfccCoefs = 12;
const mfccMinFreq = 50;
const mfccMaxFreq = 8000;

parentPort.on('message', e => {
  const {type, data} = e;
  if (type === 'analyze-soundfile') {
    console.log('analyzeSoundfile');

    const analyser = new Mfcc(mfccBands, mfccCoefs, mfccMinFreq, mfccMaxFreq, frameSize, data.sampleRate);
    const [mfccFrames, times, means, std, minRms, maxRms] = analyser.computeBufferMfcc(data.arrayData, hopSize);
    const searchTree = createKDTree(mfccFrames);
    const serializedTree = searchTree.serialize();

    parentPort.postMessage({
      type: 'analyze-soundfile',
      data: {
        filename: data.filename,
        serializedTree,
        mfccFrames,
        times,
        means,
        std,
        minRms,
        maxRms,
      }
    });
  }
})
