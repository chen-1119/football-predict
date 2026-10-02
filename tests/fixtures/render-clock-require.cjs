'use strict';
const wallClockModule = require('./wall-clock-module.cjs');

module.exports = function renderClockRequire(load, globals = {}) {
  return id => {
    if (id.endsWith('/publishedRecommendationStatus.cjs')) return require('../../src/services/publishedRecommendationStatus.cjs');
    if (id.endsWith('/useWallClock')) {
      let react;
      try { react = load('react'); }
      catch { // Direct component-function harnesses have no React renderer.
        react = { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {} };
      }
      return wallClockModule(react, { ...globals,
        window: { setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {}, ...globals.window },
        document: { addEventListener: () => {}, removeEventListener: () => {}, ...globals.document },
      });
    }
    return load(id);
  };
};
