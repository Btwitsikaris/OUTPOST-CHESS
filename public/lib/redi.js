// lib/redis.js
// Two Redis connections, each created once per warm function instance and reused:
//  - commandClient: normal GET/SET/PUBLISH/etc.
//  - subscriberClient: dedicated to SUBSCRIBE (a Redis connection in subscribe mode
//    can't run other commands, so it needs its own connection).
'use strict';
const Redis = require('ioredis');

let commandClient = null;
let subscriberClient = null;

function getRedisUrl() {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      'REDIS_URL is not set. Add it in your Vercel project\'s Environment Variables ' +
      '(Settings -> Environment Variables) using the connection string from your Upstash Redis database.'
    );
  }
  return url;
}

function getCommandClient() {
  if (!commandClient) {
    commandClient = new Redis(getRedisUrl(), { maxRetriesPerRequest: 3 });
  }
  return commandClient;
}

function getSubscriberClient() {
  if (!subscriberClient) {
    subscriberClient = new Redis(getRedisUrl(), { maxRetriesPerRequest: 3 });
  }
  return subscriberClient;
}

module.exports = { getCommandClient, getSubscriberClient };