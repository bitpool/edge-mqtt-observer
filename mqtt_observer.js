module.exports = function (RED) {
  "use strict";
  const path = require('path');
  const express = require('express');
  const socketio = require('socket.io');

  function MqttObserverNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Initialize node properties
    node.name = config.name;
    node.maxHistory = parseInt(config.maxHistory) || 50; // Increased default from 20 to 50

    // Configure batching parameters
    node.batchInterval = parseInt(config.batchInterval) || 100; // Default to 100ms if not specified
    node.maxBatchSize = parseInt(config.maxBatchSize) || 1000; // Default to 1000 messages per batch

    // Topic filtering configuration
    node.topicFilters = config.topicFilters || [];

    // Stats tracking
    node.stats = {
      totalMessages: 0,
      filteredMessages: 0,
      batchesSent: 0,
      lastResetTime: Date.now()
    };

    // Ensure path has a leading slash but no trailing slash for consistent namespacing
    node.path = config.path || '/mqtt-observer';
    if (!node.path.startsWith('/')) {
      node.path = '/' + node.path;
    }
    node.path = node.path.replace(/\/+$/, '');

    // Create an Express route for the MQTT observer page
    const app = RED.httpNode || RED.httpAdmin;
    const staticDir = path.join(__dirname, 'public');

    // Store active connections
    node.wsClients = [];

    // Message buffer and timer for batching
    let messageBuffer = {};
    let bufferTimer = null;
    let bufferCount = 0;

    // Add cleanup interval for buffer (prevent memory leaks)
    const bufferCleanupInterval = setInterval(() => {
      // Clear buffer if no clients or if buffer is old
      if (node.wsClients.length === 0 && Object.keys(messageBuffer).length > 0) {
        node.log('Clearing orphaned message buffer');
        messageBuffer = {};
        bufferCount = 0;
        if (bufferTimer) {
          clearTimeout(bufferTimer);
          bufferTimer = null;
        }
      }
    }, 120000); // Check every 2 minutes (increased from 30 seconds)

    // Function to send buffered messages to clients
    function sendBufferedMessages() {
      if (Object.keys(messageBuffer).length > 0 && node.wsClients.length > 0) {
        node.namespace.emit('mqtt-messages-batch', messageBuffer);
        node.status({ fill: "green", shape: "dot", text: `batch sent: ${Object.keys(messageBuffer).length} msgs` });

        // Update stats
        node.stats.batchesSent++;
      }

      // Always reset buffer after attempting to send
      messageBuffer = {};
      bufferCount = 0;
      bufferTimer = null;
    }

    // Function to check if a topic passes filters
    function passesFilters(topic, clientFilters) {
      // If client has no filters, apply node's default filters
      const filters = clientFilters && clientFilters.length > 0 ? clientFilters : node.topicFilters;

      // If no filters defined, allow all topics
      if (!filters || filters.length === 0) {
        return true;
      }

      // Check against each filter
      for (let i = 0; i < filters.length; i++) {
        const filter = filters[i];

        if (filter.type === 'include') {
          // Include filter
          if (topicMatchesPattern(topic, filter.pattern)) {
            return true;
          }
        } else if (filter.type === 'exclude') {
          // Exclude filter - if topic matches an exclude pattern, reject it
          if (topicMatchesPattern(topic, filter.pattern)) {
            return false;
          }
        }
      }

      // For include filters, if we got here, no patterns matched, so reject
      // For exclude filters, if we got here, no exclusion patterns matched, so accept
      return filters.some(f => f.type === 'exclude');
    }

    // Helper to match topics against patterns (supporting wildcards)
    function topicMatchesPattern(topic, pattern) {
      // Direct match
      if (pattern === topic) {
        return true;
      }

      // Convert MQTT-style wildcards to regex patterns
      if (pattern.includes('#') || pattern.includes('+')) {
        const regexPattern = pattern
          .replace(/\+/g, '[^/]+')  // + matches a single level
          .replace(/#/g, '.*');     // # matches any number of levels

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(topic);
      }

      // Simple substring match
      return topic.includes(pattern);
    }

    // Create HTTP server and Socket.IO instance if needed
    if (!RED.server) {
      node.error("No HTTP server available");
      return;
    }

    // Initialize Socket.IO with the Node-RED HTTP server
    const io = socketio(RED.server);

    // Socket.IO namespace for this specific node instance
    const namespace = io.of(node.path);
    node.namespace = namespace;

    // Log for debugging
    node.log(`MQTT Observer WebSocket namespace: ${node.path}`);

    // Handle WebSocket connections
    namespace.on('connection', function (socket) {
      // Initialize client with default settings
      const client = {
        socket: socket,
        topicFilters: [],  // Will be populated by client requests
        subscribedTopics: new Set(),
        topicPattern: null,
        isVisible: true,  // Assume client starts visible
        lastSyncRequest: Date.now()
      };

      node.wsClients.push(client);
      node.status({ fill: "green", shape: "dot", text: `connected: ${node.wsClients.length}` });

      // Send configuration to the client
      socket.emit('config', {
        maxHistory: node.maxHistory,
        batchingEnabled: true,
        statsInterval: 10000  // Send stats every 10 seconds
      });

      // Handle ping messages (for heartbeat)
      socket.on('ping', function (callback) {
        if (typeof callback === 'function') {
          callback();
        }
      });

      // Handle topic filter updates from client
      socket.on('set-topic-filter', function (filters) {
        client.topicFilters = Array.isArray(filters) ? filters : [];
        node.log(`Client updated filters: ${client.topicFilters.length} filters`);
      });

      // Handle topic subscription from client
      socket.on('subscribe-topic', function (pattern) {
        client.topicPattern = pattern || null;
        node.log(`Client subscribed to topic pattern: ${pattern}`);

        // Reset subscribed topics when pattern changes
        client.subscribedTopics = new Set();
      });

      // Add periodic cleanup for client's subscribedTopics to prevent memory leaks
      const clientCleanupInterval = setInterval(() => {
        // Limit subscribedTopics size to prevent memory leaks
        if (client.subscribedTopics.size > 25000) { // Increased from 10,000 to 25,000
          const topicsArray = Array.from(client.subscribedTopics);
          // Keep only the most recent 15000 topics (increased from 5000)
          client.subscribedTopics = new Set(topicsArray.slice(-15000));
          node.log(`Cleaned up client subscribed topics, reduced from ${topicsArray.length} to ${client.subscribedTopics.size}`);
        }
      }, 300000); // Check every 5 minutes (increased from 1 minute)

      // Send current stats to client
      socket.on('get-stats', function () {
        socket.emit('mqtt-stats', node.stats);
      });

      // Handle sync requests (for clients returning from background)
      socket.on('request-sync', function (syncInfo) {
        node.log(`Client requested sync: visible=${syncInfo.clientVisible}`);

        // Mark client as active/visible
        client.isVisible = syncInfo.clientVisible;
        client.lastSyncRequest = Date.now();

        // Send current buffer immediately if we have data
        if (Object.keys(messageBuffer).length > 0) {
          socket.emit('mqtt-messages-batch', { ...messageBuffer });
          node.log(`Sent ${Object.keys(messageBuffer).length} buffered messages to syncing client`);
        }

        // Send current stats
        socket.emit('mqtt-stats', node.stats);
      });

      // Handle disconnect
      socket.on('disconnect', function () {
        // Clean up client interval
        if (clientCleanupInterval) {
          clearInterval(clientCleanupInterval);
        }

        const index = node.wsClients.findIndex(c => c.socket === socket);
        if (index !== -1) {
          node.wsClients.splice(index, 1);
        }
        node.status({ fill: "green", shape: "ring", text: `connected: ${node.wsClients.length}` });
      });
    });

    // Serve static content
    app.use(node.path, express.static(staticDir));

    // Set up periodic stats reset
    const statsResetInterval = setInterval(() => {
      // Calculate message rate
      const now = Date.now();
      const elapsedSec = (now - node.stats.lastResetTime) / 1000;
      const msgPerSec = Math.round(node.stats.totalMessages / elapsedSec);

      // Log stats if there's traffic
      if (node.stats.totalMessages > 0) {
        node.log(`Stats: ${node.stats.totalMessages} msgs (${msgPerSec}/sec), ${node.stats.filteredMessages} filtered, ${node.stats.batchesSent} batches`);
      }

      // Reset counters
      node.stats = {
        totalMessages: 0,
        filteredMessages: 0,
        batchesSent: 0,
        lastResetTime: now
      };
    }, 300000); // Reset every 5 minutes (increased from 1 minute)

    // Handle incoming MQTT messages
    node.on('input', function (msg) {
      // Track total messages
      node.stats.totalMessages++;

      // Only process if we have clients
      if (node.wsClients.length > 0) {
        const topic = msg.topic;

        // Find clients who should receive this message
        let recipientFound = false;

        node.wsClients.forEach(client => {
          // Check client topic pattern
          if (client.topicPattern) {
            // If client has a specific pattern, check if this topic matches
            const patternMatch = topicMatchesPattern(topic, client.topicPattern);

            if (patternMatch) {
              // Mark this topic as subscribed for this client
              client.subscribedTopics.add(topic);
              recipientFound = true;
            } else if (!client.subscribedTopics.has(topic)) {
              // Skip this client if they're not subscribed to this topic
              return;
            }
          }

          // Apply additional filters
          if (!passesFilters(topic, client.topicFilters)) {
            return;
          }

          // If we get here, this client should receive the message
          recipientFound = true;
        });

        // Only add to buffer if at least one client will receive it
        if (recipientFound) {
          // Add message to buffer with topic as key
          messageBuffer[topic] = {
            topic: topic,
            payload: msg.payload,
            timestamp: Date.now()
          };

          bufferCount++;

          // Send immediately if buffer gets too large
          if (bufferCount >= node.maxBatchSize) {
            if (bufferTimer) {
              clearTimeout(bufferTimer);
              bufferTimer = null;
            }
            sendBufferedMessages();
          }
          // Otherwise set up a timer to send soon
          else if (!bufferTimer) {
            bufferTimer = setTimeout(sendBufferedMessages, node.batchInterval);
          }
        } else {
          // Count filtered messages
          node.stats.filteredMessages++;
        }

        // Update status to show buffer size
        node.status({ fill: "green", shape: "ring", text: `buffered: ${bufferCount}` });
      } else {
        node.status({ fill: "yellow", shape: "ring", text: "no clients" });
      }
    });

    // Clean up when node is removed or redeployed
    node.on('close', function () {
      // Clear all intervals
      if (statsResetInterval) {
        clearInterval(statsResetInterval);
      }
      if (bufferCleanupInterval) {
        clearInterval(bufferCleanupInterval);
      }

      // Send any remaining buffered messages
      if (bufferTimer) {
        clearTimeout(bufferTimer);
        bufferTimer = null;
        if (Object.keys(messageBuffer).length > 0) {
          sendBufferedMessages();
        }
      }

      // Clear message buffer
      messageBuffer = {};
      bufferCount = 0;

      // Disconnect all clients
      if (node.wsClients && node.wsClients.length > 0) {
        node.wsClients.forEach(client => {
          if (client.socket && client.socket.connected) {
            client.socket.disconnect(true);
          }
        });
        node.wsClients = [];
      }

      // Close the namespace if possible
      if (node.namespace) {
        Object.keys(node.namespace.connected).forEach(id => {
          node.namespace.connected[id].disconnect(true);
        });
        node.namespace.removeAllListeners();
        // Clear any remaining references
        node.namespace = null;
      }
    });
  }

  // Register the node
  RED.nodes.registerType("mqtt-observer", MqttObserverNode);
};
