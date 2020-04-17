/**
 *
 *      ioBroker pushover Adapter
 *
 *      (c) 2014-2020 bluefox <dogafox@gmail.com>
 *
 *      MIT License
 *
 */

/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';
const utils       = require('@iobroker/adapter-core'); // Get common adapter utils
const Pushover    = require('pushover-notifications');
const adapterName = require('./package.json').name.split('.').pop();
let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: adapterName});
    adapter = new utils.Adapter(options);

    adapter.getEncryptedConfig = adapter.getEncryptedConfig || getEncryptedConfig;

    try {
        adapter.tools = adapter.tools || require(utils.controllerDir + '/lib/tools');
        adapter.tools.migrateEncodedAttributes = adapter.tools.migrateEncodedAttributes || migrateEncodedAttributes;
    } catch (e) {
        adapter.tools = {decrypt, migrateEncodedAttributes};
    }

    adapter.on('message', obj => obj && obj.command === 'send' && obj.message && processMessage(adapter, obj));

    adapter.on('ready', () => {
        // automatic migration of token
        if (adapter.tools && adapter.tools.migrateEncodedAttributes) {
            adapter.tools.migrateEncodedAttributes(adapter, 'token')
                .then(migrated => {
                    if (!migrated) {
                        if (!adapter.supportsFeature || !adapter.supportsFeature('ADAPTER_AUTO_DECRYPT_NATIVE')) {
                            adapter.getEncryptedConfig('enc_token')
                                .then(value => {
                                    adapter.config.enc_token = value;
                                    main(adapter);
                                });
                        } else {
                            main(adapter);
                        }
                    }
                });
        } else {
            if (!adapter.supportsFeature || !adapter.supportsFeature('ADAPTER_AUTO_DECRYPT_NATIVE')) {
                adapter.getEncryptedConfig('enc_token')
                    .then(value => {
                        adapter.config.enc_token = value;
                        main(adapter);
                    });
            } else {
                main(adapter);
            }
        }
    });

    return adapter;
}

let pushover;
let lastMessageTime = 0;
let lastMessageText = '';

function processMessage(adapter, obj) {
    // filter out double messages
    const json = JSON.stringify(obj.message);
    if (lastMessageTime && lastMessageText === JSON.stringify(obj.message) && new Date().getTime() - lastMessageTime < 1000) {
        return adapter.log.debug('Filter out double message [first was for ' + (new Date().getTime() - lastMessageTime) + 'ms]: ' + json);
    }

    lastMessageTime = new Date().getTime();
    lastMessageText = json;

    sendNotification(adapter, obj.message, (err, response) =>
        obj.callback && adapter.sendTo(obj.from, 'send', { error: err, response: response}, obj.callback));
}

// This function migrates encrypted attributes to "enc_",
// that will be automatically encrypted and decrypted in admin and in adapter.js
//
// Usage:
// migrateEncodedAttributes(adapter, ['pass', 'token'], true).then(migrated => {
//    if (migrated) {
//       // do nothing and wait for adapter restart
//       return;
//    }
// });
function migrateEncodedAttributes(adapter, attrs, onlyRename) {
    if (typeof attrs === 'string') {
        attrs = [attrs];
    }
    const toMigrate = [];
    attrs.forEach(attr =>
        adapter.config[attr] !== undefined && adapter.config['enc_' + attr] === undefined && toMigrate.push(attr));

    if (toMigrate.length) {
        return new Promise((resolve, reject) => {
            // read system secret
            adapter.getForeignObject('system.config', null, (err, data) => {
                let systemSecret;
                if (data && data.native) {
                    systemSecret = data.native.secret;
                }
                if (systemSecret) {
                    // read instance configuration
                    adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) => {
                        if (obj && obj.native) {
                            toMigrate.forEach(attr => {
                                if (obj.native[attr]) {
                                    if (onlyRename) {
                                        obj.native['enc_' + attr] = obj.native[attr];
                                    } else {
                                        obj.native['enc_' + attr] = adapter.tools.encrypt(systemSecret, obj.native[attr]);
                                    }
                                } else {
                                    obj.native['enc_' + attr] = '';
                                }
                                delete obj.native[attr];
                            });
                            adapter.setForeignObject('system.adapter.' + adapter.namespace, obj, err => {
                                err && adapter.log.error(`Cannot write system.adapter.${adapter.namespace}: ${err}`);
                                !err && adapter.log.info('Attributes are migrated and adapter will be restarted');
                                err ? reject(err) : resolve(true);
                            });
                        } else {
                            adapter.log.error(`system.adapter.${adapter.namespace} not found!`);
                            reject(`system.adapter.${adapter.namespace} not found!`);
                        }
                    });
                } else {
                    adapter.log.error('No system secret found!');
                    reject('No system secret found!');
                }
            });
        })
    } else {
        return Promise.resolve(false);
    }
}

function getEncryptedConfig(attribute, callback) {
    if (adapter.config.hasOwnProperty(attribute)) {
        if (typeof callback !== 'function') {
            return new Promise((resolve, reject) => {
                getEncryptedConfig(attribute, (err, encrypted) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(encrypted);
                    }
                });
            });
        } else {
            adapter.getForeignObject('system.config', null, (err, data) => {
                let systemSecret;
                if (data && data.native) {
                    systemSecret = data.native.secret;
                }
                callback(null, adapter.tools.decrypt(systemSecret, adapter.config[attribute]));
            });
        }
    } else {
        if (typeof callback === 'function') {
            callback('Attribute not found');
        } else {
            return Promise.reject('Attribute not found');
        }
    }
}

/**
 * Decrypt the password/value with given key
 * @param {string} key - Secret key
 * @param {string} value - value to decript
 * @returns {string}
 */
function decrypt(key, value) {
    let result = '';
    for(let i = 0; i < value.length; i++) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

function main(adapter) {
    adapter.config.enc_token = adapter.config.enc_token || adapter.config.token;
    // do nothing. Only answer on messages.
    if (!adapter.config.user || !adapter.config.enc_token) {
        adapter.log.error('Cannot send notification while not configured');
    }
}

function onError(error, _res) {
    adapter.log.error('Error from Pushover: ' + error);
}

function sendNotification(adapter, message, callback) {
    message = message || {};

    if (!pushover) {
        if (adapter.config.user && adapter.config.enc_token) {
            pushover = new Pushover({
                user:  adapter.config.user,
                token: adapter.config.enc_tokenn
                onerror: onError
            });
        } else {
            adapter.log.error('Cannot send notification while not configured');
        }
    }

    if (!pushover) {
        return;
    }

    if (typeof message !== 'object') {
        message = {message};
    }
    if (message.hasOwnProperty('token')) {
        pushover.token = message.token;
    } else {
        pushover.token = adapter.config.enc_token;
    }
    message.title     = message.title     || adapter.config.title;
    message.sound     = message.sound     || (adapter.config.sound ? adapter.config.sound : undefined);
    message.priority  = message.priority  || adapter.config.priority;
    message.url       = message.url       || adapter.config.url;
    message.url_title = message.url_title || adapter.config.url_title;
    message.device    = message.device    || adapter.config.device;
    message.message   = message.message   || '';

    // if timestamp in ms => make seconds // if greater than 2000.01.01 00:00:00
    if (message.timestamp && message.timestamp > 946681200000) {
        message.timestamp = Math.round(message.timestamp / 1000);
    }

    // mandatory parameters if priority is high (2)
    if (message.priority === 2) {
        message.retry  = parseInt(message.retry, 10)  || 60;
        message.expire = parseInt(message.expire, 10) || 3600;
    }

    adapter.log.info('Send pushover notification: ' + JSON.stringify(message));

    pushover.send(message, (err, result) => {
        if (err) {
            adapter.log.error('Cannot send notification: ' + JSON.stringify(err));
            if (callback) callback(err);
            return false;
        } else {
            if (callback) callback(null, result);
            return true;
        }
    });
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
