
  cordova.define('cordova/plugin_list', function(require, exports, module) {
    module.exports = [
      {
          "id": "nodejs-mobile-cordova.nodejs",
          "file": "plugins/nodejs-mobile-cordova/www/nodejs_apis.js",
          "pluginId": "nodejs-mobile-cordova",
        "clobbers": [
          "nodejs"
        ]
        },
      {
          "id": "nodejs-mobile-cordova.nodejs_events",
          "file": "plugins/nodejs-mobile-cordova/www/nodejs_events.js",
          "pluginId": "nodejs-mobile-cordova",
        "clobbers": [
          "nodejs_events"
        ]
        }
    ];
    module.exports.metadata =
    // TOP OF METADATA
    {
      "nodejs-mobile-cordova": "0.4.3"
    };
    // BOTTOM OF METADATA
    });
    