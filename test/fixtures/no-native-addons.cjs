'use strict';

// Preload for portability verification. Native-capable crypto dependencies must
// select their JavaScript fallbacks when no platform addon can be loaded.
require('node:module')._extensions['.node'] = () => {
  throw new Error('Native addon loading disabled for diodejs portability tests');
};
