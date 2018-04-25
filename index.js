#!/usr/bin/env node

const log = require('yalm');
const Mqtt = require('mqtt');
const Hue = require('node-hue-api');
const pjson = require('persist-json')('hue2mqtt');
const config = require('./config.js');
const pkg = require('./package.json');
const equal = require('deep-equal');
const extend = require('extend');

let mqtt;
let mqttConnected = false;
let bridgeConnected = false;
let bridgeAddress;
let bridgeId;
let bridgeUser;
let hue;
let pollingTimer;
const pollingInterval = (config.pollingInterval || 10) * 1000;
const groupNames = {};
const groupStates = {};
const lightNames = {};
const lightStates = {};
const sensorNames = {};
const sensorStates = {};

function start() {
	log.setLevel(config.verbosity);
	log.info(pkg.name + ' ' + pkg.version + ' starting');

	if (config.bridge) {
		bridgeAddress = config.bridge;
		log.debug('bridge address', bridgeAddress);
		getBridgeId();
	} else {
		Hue.nupnpSearch((err, result) => {
			if (err) {
				log.error('can\'t find a hue bridge', err.toString());
				process.exit(1);
			} else if (result.length > 0) {
				bridgeAddress = result[0].ipaddress;
				log.info('found bridge on', bridgeAddress);
				getBridgeId();
			} else {
				log.error('can\'t find a hue bridge');
				process.exit(1);
			}
		});
	}

	log.info('mqtt trying to connect', config.mqttUrl);

	mqtt = Mqtt.connect(config.mqttUrl, {
		clientId: config.name + '_' + Math.random().toString(16).substr(2, 8),
		will: {topic: config.name + '/connected', payload: '0', retain: (config.mqttRetain)},
		rejectUnauthorized: !config.insecure
	});

	mqtt.on('connect', () => {
		mqttConnected = true;
		log.info('mqtt connected', config.mqttUrl);
		mqtt.publish(config.name + '/connected', bridgeConnected ? '2' : '1', {retain: config.mqttRetain});
		log.info('mqtt subscribe', config.name + '/set/#');
		mqtt.subscribe(config.name + '/set/#');
	});

	mqtt.on('close', () => {
		if (mqttConnected) {
			mqttConnected = false;
			log.info('mqtt closed ' + config.mqttUrl);
		}
	});

	mqtt.on('error', err => {
		log.error('mqtt', err.toString());
	});

	mqtt.on('offline', () => {
		log.error('mqtt offline');
	});

	mqtt.on('reconnect', () => {
		log.info('mqtt reconnect');
	});

	mqtt.on('message', (topic, payload) => {
		payload = payload.toString();
		log.debug('mqtt <', topic, payload);

		if (payload.indexOf('{') !== -1) {
			try {
				payload = JSON.parse(payload);
			} catch (err) {
				log.error(err.toString());
			}
		} else if (payload === 'false') {
			payload = false;
		} else if (payload === 'true') {
			payload = true;
		} else if (!isNaN(payload)) {
			payload = parseFloat(payload);
		}
		const [, method, type, name, datapoint] = topic.split('/');

		switch (method) {
			case 'set':
				switch (type) {
					case 'lights':
						if (datapoint) {
							setDatapoint(type, name, datapoint, payload);
						} else if (typeof payload === 'object') {
							setLightState(name, payload);
						} else {
							setValue(type, name, payload);
						}
						break;

					case 'groups':
						if (datapoint) {
							setDatapoint(type, name, datapoint, payload);
						} else if (typeof payload === 'object') {
							setGroupLightState(name, payload);
						} else {
							setValue(type, name, payload);
						}
						break;

					default:
						log.error('unknown type', type);
				}
				break;

			default:
				log.error('unknown method', method);
		}
	});
}

function setGroupLightState(name, state) {
	let id = groupNames[name];
	if (!id && groupStates[name]) {
		id = name;
	}
	if (id) {
		log.debug('hue > setGroupLightState', id, state);
		hue.setGroupLightState(id, state, (err, res) => {
			if (err) {
				log.error('setGroupLightState', name, err.toString());
				if (err.message.endsWith('is not modifiable. Device is set to off.')) {
					bridgeConnect();
				} else {
					bridgeDisconnect();
				}
			} else if (!res) {
				log.error('setGroupLightState', name, 'failed');
			}
		});
	} else {
		log.error('unknown group', name);
	}
}

function setLightState(name, state) {
	let id = lightNames[name];
	if (!id && lightStates[name]) {
		id = name;
	}
	if (id) {
		log.debug('hue > setLightState', id, state);
		hue.setLightState(id, state, (err, res) => {
			if (err) {
				log.error('setLightState', err.toString());
				if (err.message.endsWith('is not modifiable. Device is set to off.')) {
					bridgeConnect();
				} else {
					bridgeDisconnect();
				}
			} else if (!res) {
				log.error('setLightState', name, 'failed');
			}
		});
	} else {
		log.error('unknown light', name);
	}
}

function setDatapoint(type, name, datapoint, payload) {
	const obj = {};
	obj[datapoint] = payload;
	if (type === 'groups') {
		setGroupLightState(name, obj);
	} else if (type === 'lights') {
		setLightState(name, obj);
	}
}

function setValue(type, name, payload) {
	if (payload === false) {
		payload = {on: false};
	} else if (payload === true) {
		payload = {on: true};
	} else {
		payload = parseInt(payload, 10);
		if (payload === 0) {
			payload = {on: false, bri: 0};
		} else {
			payload = {on: true, bri: payload};
		}
	}
	if (type === 'lights') {
		setLightState(name, payload);
	} else if (type === 'groups') {
		setGroupLightState(name, payload);
	}
}

function mqttPublish(topic, payload, options) {
	if (!payload) {
		payload = '';
	} else if (typeof payload !== 'string') {
		payload = JSON.stringify(payload);
	}
	log.debug('mqtt >', topic, payload);
	mqtt.publish(topic, payload, options);
}

function getBridgeId() {
	log.debug('getBridgeId');
	hue = new Hue.HueApi(bridgeAddress, 'none');
	hue.config((err, bridgeConfig) => {
		if (err) {
			log.error('bridge connect', err.toString());
			setTimeout(getBridgeId, pollingInterval);
		} else {
			bridgeId = bridgeConfig.replacesbridgeid || bridgeConfig.bridgeid;
			log.debug('bridge id', bridgeId);
			initApi();
		}
	});
}

function initApi() {
	bridgeUser = pjson.load('user-' + bridgeId);
	hue = new Hue.HueApi(bridgeAddress, bridgeUser);
	if (!bridgeUser) {
		log.warn('no bridge user found');
		registerUser();
		return;
	}
	hue.config((err, bridgeConfig) => {
		if (err) {
			log.error('bridge connect', err.toString());
			setTimeout(initApi, pollingInterval);
		} else {
			bridgeId = bridgeConfig.replacesbridgeid || bridgeConfig.bridgeid;
			log.debug('bridge api version', bridgeConfig.apiversion);
			log.debug('bridge user', bridgeUser);
			if (typeof bridgeConfig.linkbutton === 'undefined') {
				log.error('username not known to bridge');
				registerUser();
			} else {
				bridgeConnect();
				if (bridgeConfig.swupdate.updatestate && bridgeConfig.swupdate.devicetypes.bridge) {
					log.warn('bridge update available:', bridgeConfig.swupdate.text);
				}
				getStates();
			}
		}
	});
}

function getStates()
{
	getGroups();
	getLights();
	getSensors();
	pollingTimer = setTimeout(getStates, pollingInterval);
}

function registerUser() {
	hue.createUser(bridgeAddress, 'hue2mqtt.js', (err, user) => {
		if (err) {
			if (err.toString() === 'Api Error: link button not pressed') {
				log.warn('please press the link button');
				mqttPublish('hue/status/authrequired');
				setTimeout(registerUser, 5000);
			} else {
				log.error(err.toString());
			}
		} else {
			log.info('got username', user);
			pjson.save('user-' + bridgeId, user);
			initApi();
		}
	});
}

function bridgeConnect() {
	if (!bridgeConnected) {
		bridgeConnected = true;
		log.info('bridge connected');
		mqttPublish(config.name + '/connected', '2', {retain: config.mqttRetain});
	}
}

function bridgeDisconnect() {
	if (bridgeConnected) {
		bridgeConnected = false;
		log.error('bridge disconnected');
		mqttPublish(config.name + '/connected', '1', {retain: config.mqttRetain});
	}
}

function getLights(callback) {
	log.debug('hue > getLights');
	hue.lights((err, res) => {
		if (err) {
			log.error('getLights', err.toString());
			bridgeDisconnect();
		} else if (res.lights && res.lights.length > 0) {
			bridgeConnect();
			res.lights.forEach(light => {
				// console.log(JSON.stringify(light, null, 2));
				lightNames[light.name] = light.id;
				publishLightChanges(light);
			});
			log.debug('got', res.lights.length, 'lights');
		}
		if (typeof callback === 'function') {
			callback();
		}
	});
}

function getGroups(callback) {
	log.debug('hue > getGroups');
	hue.groups((err, res) => {
		if (err) {
			log.error('getGroups', err.toString());
			bridgeDisconnect();
		} else if (res && res.length > 0) {
			bridgeConnect();
			res.forEach(group => {
				// console.log(JSON.stringify(group, null, 2));
				groupNames[group.name] = group.id;
				publishGroupLightChanges(group);
			});
			log.debug('got', res.length, 'groups');
		}
		if (typeof callback === 'function') {
			callback();
		}
	});
}

function getSensors(callback) {
	log.debug('hue > getSensors');
	hue.sensors((err, res) => {
		if (err) {
			log.error('getSensors', err.toString());
			bridgeDisconnect();
		} else if (res.sensors && res.sensors.length > 0) {
			bridgeConnect();
			res.sensors.forEach(sensor => {
				// console.log(JSON.stringify(sensor, null, 2));
				sensorNames[sensor.name] = sensor.id;
				publishSensorChanges(sensor);
			});
			log.debug('got', res.sensors.length, 'sensors');
		}
		if (typeof callback === 'function') {
			callback();
		}
	});
}

function publishLightChanges(light) {
	
	if (!lightStates[light.id]) {
		lightStates[light.id] = {};
	}
	
	const changes = !equal(lightStates[light.id], light);
	extend(lightStates[light.id], light);
	
	if (changes) {
		const payload = lightStates[light.id];
		const topic = config.name + '/status/lights/' + (config.disableNames ? light.id : light.name);
		mqttPublish(topic, payload, {retain: config.mqttRetain});
	}
}

function publishGroupLightChanges(group) {
	
	if (!groupStates[group.id]) {
		groupStates[group.id] = {};
	}
	
	const changes = !equal(groupStates[group.id], group);
	extend(groupStates[group.id], group);
	
	if (changes) {
		const payload = groupStates[group.id];
		const topic = config.name + '/status/groups/' + (config.disableNames ? group.id : group.name);
		mqttPublish(topic, payload, {retain: config.mqttRetain});
	}
}

function publishSensorChanges(sensor) {
	
	if (!sensorStates[sensor.id]) {
		sensorStates[sensor.id] = {};
	}
	
	const changes = !equal(sensorStates[sensor.id], sensor);
	extend(sensorStates[sensor.id], sensor);
	
	if (changes) {
		const payload = sensorStates[sensor.id];
		const topic = config.name + '/status/sensor/' + (config.disableNames ? sensor.id : sensor.name);
		mqttPublish(topic, payload, {retain: config.mqttRetain});
	}
}

start();
