import { parentPort } from 'worker_threads';
import createKDTree from 'static-kdtree';

let tree = null;

parentPort.on('message', e => {
  const {type, data} = e;
  if (type === 'tree') {
    tree = createKDTree.deserialize(data.tree);
  }
  if (type === 'target') {
    const targets = tree.knn(data.mfcc, data.randomizer);
    parentPort.postMessage({
      type: 'target',
      data: {
        targets: targets,
        rms: data.rms,
      }
    });
  }
});