/**
 * MQTT Observer Vue Application
 * Production-ready real-time MQTT data visualization dashboard
 */
(function () {
  'use strict';

  /**
   * Gets the Socket.IO namespace from the current pathname
   * @returns {string} Normalized namespace path
   */
  const getNamespace = () => {
    return window.location.pathname.replace(/\/+$/, '');
  };

  // Constants for memory management
  const MEMORY_CHECK_INTERVAL = 300000; // Check memory usage every 5 minutes (was 1 minute)
  const MAX_TOPICS = 200000; // Maximum number of topics to keep in memory (increased from 100k)
  const MAX_HISTORY_ENTRIES_TOTAL = 500000; // Maximum total history entries (increased from 250k)
  const PRUNE_TARGET_PERCENTAGE = 0.2; // Remove 20% of topics when pruning (was 30%)

  // Page Visibility API support for handling background tab throttling
  let isPageVisible = !document.hidden;
  let visibilityChangeHandler = null;
  let backgroundReconnectTimer = null;

  document.addEventListener('DOMContentLoaded', initVueApp);

  /**
   * Initializes the Vue application and all components
   */
  function initVueApp() {
    const { createApp } = Vue;

    /**
     * Custom Virtual Tree Component for high-performance rendering of large topic hierarchies
     * Uses virtual scrolling to handle thousands of nodes efficiently
     */
    const VirtualTree = {
      props: {
        nodes: { type: Array, default: () => [] },
        nodeHeight: { type: Number, default: 36 },
        visibleCount: { type: Number, default: 25 },
        expandedKeys: { type: Object, default: () => ({}) }
      },
      emits: ['node-click', 'node-expand', 'node-collapse'],
      data() {
        return {
          scrollTop: 0,
          containerHeight: 600,
          isMounted: false
        };
      },
      computed: {
        // Flatten tree into a linear array for virtualization
        flattenedNodes() {
          const result = [];

          const flatten = (nodes, depth = 0) => {
            for (const node of nodes) {
              result.push({ ...node, depth });

              // Add children if node is expanded
              if (!node.leaf && this.expandedKeys[node.key] && node.children) {
                flatten(node.children, depth + 1);
              }
            }
          };

          flatten(this.nodes);
          return result;
        },

        // Calculate which nodes to render based on scroll position
        visibleNodes() {
          const startIndex = Math.floor(this.scrollTop / this.nodeHeight);
          const endIndex = Math.min(
            startIndex + this.visibleCount + 2, // +2 for buffer
            this.flattenedNodes.length
          );

          return this.flattenedNodes
            .slice(startIndex, endIndex)
            .map((node, index) => ({
              ...node,
              virtualIndex: startIndex + index,
              top: (startIndex + index) * this.nodeHeight
            }));
        },

        totalHeight() {
          return this.flattenedNodes.length * this.nodeHeight;
        }
      },
      methods: {
        onScroll(event) {
          this.scrollTop = event.target.scrollTop;
        },

        handleNodeClick(node) {
          this.$emit('node-click', { node });
        },

        toggleExpansion(node) {
          if (!node.leaf) {
            if (this.expandedKeys[node.key]) {
              this.$emit('node-collapse', { node });
            } else {
              this.$emit('node-expand', { node });
            }
          }
        }
      },
      mounted() {
        this.containerHeight = this.$el.clientHeight;
        this.isMounted = true;

        // Add resize observer to track container height changes
        if (window.ResizeObserver) {
          this.resizeObserver = new ResizeObserver((entries) => {
            try {
              // Check if component is still mounted/active
              if (!this.isMounted || !this.$el || !this.$data || this.$.isUnmounted) {
                return;
              }

              for (const entry of entries) {
                this.containerHeight = entry.contentRect.height;
                // Update visible count based on container height
                this.visibleCount = Math.ceil(this.containerHeight / this.nodeHeight) + 5;
              }
            } catch (error) {
              // Silently handle errors when component is being destroyed
            }
          });
          this.resizeObserver.observe(this.$el);
        }
      },
      beforeUnmount() {
        // Mark component as unmounted to prevent ResizeObserver callbacks
        this.isMounted = false;

        // Clean up ResizeObserver to prevent memory leaks and callback errors
        if (this.resizeObserver) {
          this.resizeObserver.disconnect();
          this.resizeObserver = null;
        }
      },
      template: `
        <div 
          class="virtual-tree" 
          @scroll="onScroll"
          :style="{ height: '100%', overflow: 'auto' }">
          <div :style="{ height: totalHeight + 'px', position: 'relative' }">
            <div 
              v-for="node in visibleNodes" 
              :key="node.key"
              :style="{ 
                position: 'absolute', 
                top: node.top + 'px', 
                left: 0, 
                right: 0, 
                height: nodeHeight + 'px',
                display: 'flex',
                alignItems: 'center'
              }"
              :class="['virtual-tree-node', node.styleClass, { 'tree-leaf': node.leaf }]">
              
              <span 
                :style="{ marginLeft: (node.depth * 16) + 'px' }"
                class="tree-node-content"
                @click="node.leaf ? handleNodeClick(node) : toggleExpansion(node)">
                
                <span class="tree-toggle" v-if="!node.leaf">
                  <i :class="expandedKeys[node.key] ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"></i>
                </span>
                <span class="tree-toggle-spacer" v-else></span>
                
                <i :class="node.icon" class="tree-icon"></i>
                <span class="tree-label">{{ node.label }}</span>
              </span>
            </div>
          </div>
        </div>
      `
    };

    // Create Vue app
    const app = createApp({
      data() {
        return {
          // Socket connection
          socket: null,
          connectionState: 'connecting',
          connectionStatus: 'Connecting...',
          heartbeatInterval: null,
          reconnectTimer: null,
          lastHeartbeat: 0,

          // Topic data
          topicData: {}, // Stores the latest message for each topic
          topicHistory: {}, // Stores history for each topic
          treeNodes: [], // Tree nodes for PrimeVue Tree
          selectedNodeKey: null, // Currently selected tree node key
          topicSearch: '', // Search term for filtering topics

          // Persistent tree structure for stable UI
          persistentTreeStructure: {}, // Maintains stable tree hierarchy
          rootTopics: new Set(), // Track root topics to prevent removal
          expandedNodeKeys: {}, // Track which nodes are expanded for lazy loading

          // Stats
          mqttStats: {
            totalMessages: 0,
            filteredMessages: 0,
            batchesSent: 0,
            messageRate: 0
          },
          statsUpdateInterval: null,

          // Performance optimization flags
          batchingEnabled: true,
          processingBatch: false,
          batchChunkSize: 100, // Process this many messages at once
          updateTreeThrottleTimeout: null,

          // Topic map for faster lookup (will gradually replace topicData)
          topicMap: new Map(),

          // Selected topic
          selectedTopic: null,
          selectedTimestamp: '',
          selectedPayload: null,

          // Message history
          messageHistory: [], // Stores all messages in order of arrival
          historyLimit: 50, // Maximum number of messages to keep in history per topic (increased from 20)
          maxHistoryConfig: 50, // Will be updated from server config (increased from 20)

          // Chart data (simple primitives only, don't store complex objects here)
          chartLabels: [],
          chartValues: [],
          chartTimeRange: 'all', // Options: all, hour, minute
          selectedProperty: 'presentValue', // Default property to extract from payload objects
          availableProperties: [], // Will be populated when a topic is selected
          isStringProperty: false, // Whether selected property contains string values

          // Configuration
          maxMessages: 100,
          reconnectInterval: 5000,

          // Memory management
          memoryCheckTimer: null,
          lastMemoryCheck: 0,
          pruneCount: 0,

          // Page visibility tracking
          isPageVisible: true,
          wasHiddenLongTime: false,
          hiddenStartTime: null,
        };
      },
      computed: {
        // Format the payload for display
        formattedPayload() {
          if (this.selectedPayload == null && !this.selectedTopic) {
            return '<div class="no-messages"><i class="pi pi-inbox"></i><p>Select a topic to view its payload</p></div>';
          }

          if (this.selectedPayload == null && this.selectedTopic) {
            return '<div class="no-messages"><i class="pi pi-info-circle"></i><p>No messages received yet for "' + this.selectedTopic + '"</p></div>';
          }

          return `<div class="mqtt-payload">${this.formatPayload(this.selectedPayload)}</div>`;
        },

        // Filter history for the selected topic
        filteredHistory() {
          if (!this.selectedTopic) return [];
          return this.topicHistory[this.selectedTopic] || [];
        },

        filteredTopics() {
          if (!this.topicSearch) {
            return this.topics;
          }

          const searchTerm = this.topicSearch.toLowerCase();
          const filterNode = (node) => {
            if (node.label.toLowerCase().includes(searchTerm)) {
              return true;
            }
            if (node.children) {
              const filteredChildren = node.children
                .map(child => filterNode(child))
                .filter(Boolean);
              if (filteredChildren.length > 0) {
                node.children = filteredChildren;
                return true;
              }
            }
            return false;
          };

          return this.topics
            .map(topic => {
              const node = { ...topic };
              return filterNode(node) ? node : null;
            })
            .filter(Boolean);
        },

        // Filter tree nodes based on search term
        filteredTreeNodes() {
          if (!this.topicSearch || !this.treeNodes) {
            return this.treeNodes;
          }

          const searchTerm = this.topicSearch.toLowerCase().trim();
          if (!searchTerm) {
            return this.treeNodes;
          }

          // Use non-reactive filtering for better performance
          const filterNodeNonReactive = (node) => {
            // Check if current node matches
            const nodeMatches = node.label.toLowerCase().includes(searchTerm);

            // If node has children, filter them
            let filteredChildren = [];
            if (node.children && node.children.length > 0) {
              filteredChildren = node.children
                .map(filterNodeNonReactive)
                .filter(n => n !== null);
            }

            // Keep this node if it matches or has matching children
            if (nodeMatches) {
              // Node itself matches, return a frozen copy with all children
              return Object.freeze({
                ...node,
                children: node.children ? Object.freeze([...node.children]) : undefined
              });
            } else if (filteredChildren.length > 0) {
              // Node doesn't match but has matching descendants
              return Object.freeze({
                ...node,
                children: Object.freeze(filteredChildren)
              });
            }

            // Neither node nor its children match
            return null;
          };

          // Apply filter to all root nodes and freeze result
          const filtered = this.treeNodes
            .map(filterNodeNonReactive)
            .filter(node => node !== null);

          return Object.freeze(filtered);
        }
      },
      methods: {
        /**
         * Initializes WebSocket connection with robust reconnection handling
         */
        setupWebSocket() {
          const namespace = getNamespace();

          // Connect to the namespace with robust reconnection options optimized for background tabs
          this.socket = io(namespace, {
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            autoConnect: true,
            // Enhanced options for background tab support
            forceNew: false,
            upgrade: true,
            rememberUpgrade: true,
            transports: ['websocket', 'polling'] // Fallback to polling if websocket fails
          });

          // Connection event handlers
          this.socket.on('connect', this.handleConnect);
          this.socket.on('disconnect', this.handleDisconnect);
          this.socket.on('connect_error', this.handleConnectError);
          this.socket.on('reconnect', this.handleReconnect);
          this.socket.on('reconnect_attempt', this.handleReconnectAttempt);
          this.socket.on('reconnect_error', this.handleReconnectError);
          this.socket.on('reconnect_failed', this.handleReconnectFailed);

          // Configuration event handler
          this.socket.on('config', this.handleConfig);

          // MQTT message event handlers
          this.socket.on('mqtt-message', this.processMessage);
          this.socket.on('mqtt-messages-batch', this.processBatchedMessages);
        },

        // Handle MQTT stats updates
        handleStats(stats) {
          if (!stats) return;

          this.mqttStats = { ...stats };

          // Calculate message rate if possible
          if (stats.totalMessages && stats.lastResetTime) {
            const now = Date.now();
            const elapsedSec = (now - stats.lastResetTime) / 1000;
            if (elapsedSec > 0) {
              this.mqttStats.messageRate = Math.round(stats.totalMessages / elapsedSec);
            }
          }
        },

        // Handle configuration from server
        handleConfig(config) {
          if (config && typeof config === 'object') {
            if (config.maxHistory && typeof config.maxHistory === 'number') {
              this.maxHistoryConfig = config.maxHistory;
              this.historyLimit = config.maxHistory;
            }

            // Set batching mode based on server config
            if (config.batchingEnabled !== undefined) {
              this.batchingEnabled = !!config.batchingEnabled;
            }
          }
        },

        // Connection event handlers
        handleConnect() {
          this.connectionState = 'connected';
          this.connectionStatus = 'Connected';
          this.lastHeartbeat = Date.now(); // Reset heartbeat on connection

          if (this.wasHiddenLongTime) {
            this.requestDataSync();
          }
        },

        handleDisconnect(reason) {
          this.connectionState = 'disconnected';
          this.connectionStatus = 'Disconnected - Reconnecting...';

          // If the server was explicitly closed (like during redeploy), force reconnection
          if (reason === 'io server disconnect') {
            // Server was shut down - try to reconnect immediately
            this.socket.connect();
          }
        },

        /**
         * Handles WebSocket connection errors
         * @param {Error} error - Connection error details
         */
        handleConnectError(error) {
          this.connectionState = 'error';
          this.connectionStatus = 'Connection Error - Retrying...';
        },

        handleReconnect(attemptNumber) {
          this.connectionState = 'connected';
          this.connectionStatus = 'Connected';
        },

        handleReconnectAttempt(attemptNumber) {
          this.connectionState = 'connecting';
          this.connectionStatus = `Reconnecting (Attempt ${attemptNumber})...`;
        },

        /**
         * Handles WebSocket reconnection errors
         * @param {Error} error - Reconnection error details
         */
        handleReconnectError(error) {
          this.connectionState = 'error';
          this.connectionStatus = 'Reconnection Error - Retrying...';
        },

        /**
         * Handles failed reconnection attempts after maximum retries
         */
        handleReconnectFailed() {
          this.connectionState = 'error';
          this.connectionStatus = 'Reconnection Failed - Refresh Page';
        },

        // Check memory usage and prune data if needed
        checkMemoryUsage() {
          const topicCount = Object.keys(this.topicData).length;

          // Calculate total history entries
          let totalHistoryEntries = 0;
          for (const topic in this.topicHistory) {
            totalHistoryEntries += this.topicHistory[topic]?.length || 0;
          }

          // Check if we need to prune topics
          if (topicCount > MAX_TOPICS) {
            this.pruneTopics(Math.floor(topicCount * PRUNE_TARGET_PERCENTAGE));
          }

          // Check if we need to prune history entries
          if (totalHistoryEntries > MAX_HISTORY_ENTRIES_TOTAL) {
            this.pruneHistory(totalHistoryEntries - MAX_HISTORY_ENTRIES_TOTAL);
          }

          this.lastMemoryCheck = Date.now();
        },

        // Prune old/unused topics to save memory
        pruneTopics(countToPrune) {
          // Get all topics and their timestamps
          const topicsByTime = Object.keys(this.topicData)
            .map(topic => ({
              topic,
              timestamp: this.topicData[topic].timestamp || 0
            }))
            .sort((a, b) => a.timestamp - b.timestamp); // Oldest first

          // Keep selected topic and recent ones
          const topicsToRemove = topicsByTime
            .slice(0, countToPrune) // Take oldest topics
            .filter(item => item.topic !== this.selectedTopic) // Don't remove selected topic
            .map(item => item.topic);


          // Remove the topics
          topicsToRemove.forEach(topic => {
            delete this.topicData[topic];
            this.topicMap.delete(topic);

            // Also delete from history if no longer needed
            if (topic !== this.selectedTopic) {
              delete this.topicHistory[topic];
            }
          });

          this.pruneCount += topicsToRemove.length;

          // Schedule a tree update after pruning
          this.throttledUpdateTopicTree();
        },

        // Prune history entries to save memory
        pruneHistory(entriesToPrune) {

          // Reduce history for all topics proportionally
          // but leave the selected topic's history intact
          const topics = Object.keys(this.topicHistory).filter(t => t !== this.selectedTopic);

          if (topics.length === 0) return;

          // How many entries to remove per topic
          const entriesPerTopic = Math.ceil(entriesToPrune / topics.length);

          topics.forEach(topic => {
            const history = this.topicHistory[topic] || [];
            if (history.length > entriesPerTopic) {
              // Keep only the most recent entries
              this.topicHistory[topic] = history.slice(0, history.length - entriesPerTopic);
            } else {
              // Remove entire history for this topic if we're pruning aggressively
              delete this.topicHistory[topic];
            }
          });
        },

        // Start memory checks
        startMemoryChecks() {
          this.lastMemoryCheck = Date.now();
          this.memoryCheckTimer = setInterval(() => {
            this.checkMemoryUsage();
          }, MEMORY_CHECK_INTERVAL);
        },

        // Stop memory checks
        stopMemoryChecks() {
          if (this.memoryCheckTimer) {
            clearInterval(this.memoryCheckTimer);
            this.memoryCheckTimer = null;
          }
        },

        // Process a batch of messages received from the server
        processBatchedMessages(messageBatch) {
          if (this.processingBatch) return; // Avoid overlapping batch processing

          this.processingBatch = true;

          // Get all topics from the batch
          const topics = Object.keys(messageBatch);
          const totalMessages = topics.length;

          // Check memory immediately if we're getting a lot of messages
          if (totalMessages > 10000 && Date.now() - this.lastMemoryCheck > 5000) {
            this.checkMemoryUsage();
          }

          let processedCount = 0;
          let selectedTopicUpdated = false;

          // Process messages in chunks to avoid UI blocking
          const processNextChunk = (startIndex) => {
            const endIndex = Math.min(startIndex + this.batchChunkSize, topics.length);
            const chunk = topics.slice(startIndex, endIndex);

            // Process each message in the chunk
            chunk.forEach(topic => {
              const message = messageBatch[topic];
              this.processMessage(message, false); // Don't update UI for each message

              // Check if this message is for the currently selected topic
              if (this.selectedTopic && this.normalizeTopic(message.topic) === this.selectedTopic) {
                selectedTopicUpdated = true;
              }
            });

            processedCount += chunk.length;

            // If more chunks to process, schedule next chunk with setTimeout
            if (endIndex < topics.length) {
              setTimeout(() => {
                processNextChunk(endIndex);
              }, 0);
            } else {
              // All chunks processed, now update the UI once
              this.throttledUpdateTopicTree();

              // If we got a message for the selected topic, update payload and chart
              if (selectedTopicUpdated && this.selectedTopic && this.topicData[this.selectedTopic]) {
                this.displayPayload(this.topicData[this.selectedTopic]);
                this.updateChart();
              }

              this.processingBatch = false;
            }
          };

          // Start processing the first chunk
          processNextChunk(0);
        },

        // Throttled version of updateTopicTree to prevent too many UI updates
        throttledUpdateTopicTree() {
          if (this.updateTreeThrottleTimeout) {
            clearTimeout(this.updateTreeThrottleTimeout);
          }

          this.updateTreeThrottleTimeout = setTimeout(() => {
            this.updateTopicTree();
            this.updateTreeThrottleTimeout = null;
          }, 50); // Only update tree every 200ms max
        },

        /**
         * Processes an incoming MQTT message and updates the UI
         * @param {Object} message - MQTT message object with topic and payload
         * @param {boolean} updateUi - Whether to trigger UI updates
         */
        processMessage(message, updateUi = true) {
          if (!message || !message.topic) return;

          // Normalize topic format (ensure consistent leading slashes)
          const topic = this.normalizeTopic(message.topic);

          // Store with the normalized topic
          const normalizedMessage = { ...message, topic };
          this.topicData[topic] = normalizedMessage;
          this.topicMap.set(topic, normalizedMessage); // Add to Map for faster future lookups

          // Add to message history for this topic
          this.addToTopicHistory(normalizedMessage);

          // Also add to global history for reference
          this.addToHistory(normalizedMessage);

          // Update the topic tree structure - only if updateUi flag is true
          if (updateUi) {
            this.throttledUpdateTopicTree();
          }

          // If the current topic is selected, update the payload view and chart
          if (updateUi && this.selectedTopic === topic) {
            this.displayPayload(normalizedMessage);
            this.updateChart();
          }
        },

        // Add message to global history
        addToHistory(message) {
          // Add to the beginning of the array (newest first)
          this.messageHistory.unshift(message);

          // Trim overall history if needed - keep more entries now
          if (this.messageHistory.length > this.historyLimit * 10) { // Increased from * 5 to * 10
            this.messageHistory = this.messageHistory.slice(0, this.historyLimit * 10);
          }
        },

        // Add message to topic-specific history
        addToTopicHistory(message) {
          if (!message || !message.topic) return;

          const topic = message.topic;

          // Initialize history array for this topic if it doesn't exist
          if (!this.topicHistory[topic]) {
            this.topicHistory[topic] = [];
          }

          // Add to the beginning of this topic's history array (newest first)
          this.topicHistory[topic].unshift(message);

          // Check if we need to trim history
          if (this.topicHistory[topic].length > this.historyLimit) {
            // Create a new array instead of modifying in place
            const trimmedHistory = this.topicHistory[topic].slice(0, this.historyLimit);
            this.$nextTick(() => {
              this.topicHistory[topic] = trimmedHistory;

              // If this is the currently selected topic, update the chart
              if (topic === this.selectedTopic) {
                // Allow Vue to update the data first
                this.$nextTick(() => {
                  this.updateChart();
                });
              }
            });
          }
        },

        // Clear history
        clearHistory() {
          if (this.selectedTopic) {
            // Clear only the selected topic's history
            this.topicHistory[this.selectedTopic] = [];
          }
        },

        // Show a historical message
        showHistoricalMessage(message) {
          if (!message) return;
          this.displayPayload(message);
        },

        // Format timestamp for display
        formatTimestamp(timestamp) {
          if (!timestamp) return '';
          return new Date(timestamp).toLocaleTimeString();
        },

        // Normalize topic to consistent format 
        normalizeTopic(topic) {
          // Remove leading and trailing slashes for consistent storage
          return topic.replace(/^\/+|\/+$/g, '');
        },

        // Update the PrimeVue tree nodes from topics - STABLE VERSION
        updateTopicTree() {
          // Process new topics and add them to persistent structure
          const topics = Object.keys(this.topicData);
          let hasNewRootTopics = false;

          // Process each topic and update persistent structure
          topics.forEach(topic => {
            const segments = this.normalizeTopic(topic).split('/').filter(Boolean);
            if (segments.length === 0) return;

            const rootTopic = segments[0];

            // Check if we have a new root topic
            if (!this.rootTopics.has(rootTopic)) {
              this.rootTopics.add(rootTopic);
              hasNewRootTopics = true;
            }

            // Build/update the persistent tree structure
            let current = this.persistentTreeStructure;
            segments.forEach((segment, index) => {
              if (!current[segment]) {
                current[segment] = {};
              }
              current = current[segment];
            });
          });

          // Always rebuild tree nodes to ensure hasData metadata is current
          // This prevents the "No data available" issue caused by stale metadata
          this.treeNodes = this.convertToTreeNodes(this.persistentTreeStructure);
        },

        // Convert topic hierarchy to PrimeVue tree format with lazy loading
        convertToTreeNodes(topicTree, parentPath = '', depth = 0) {
          const result = [];

          // Process keys in sorted order
          const keys = Object.keys(topicTree).sort();

          for (const key of keys) {
            const fullPath = parentPath ? `${parentPath}/${key}` : key;

            // Check if this path has children in the tree structure
            const hasChildren = Object.keys(topicTree[key]).length > 0;

            // Check if this path has actual MQTT data
            const hasData = !!this.topicData[fullPath];

            // Create node data
            const node = {
              key: fullPath,
              label: key,
              data: fullPath,
              icon: hasData ? 'pi pi-circle-fill' : (hasChildren ? 'pi pi-box' : 'pi pi-circle'),
              leaf: !hasChildren,
              hasData: hasData, // Add metadata to help with selection logic
              styleClass: hasData ? 'has-data' : 'intermediate-node'
            };

            // For root level (depth 0), always show nodes
            // For deeper levels, only show if parent is expanded or if we're building initial tree
            if (depth === 0) {
              // Root level - always show
              if (hasChildren) {
                // Always add children for virtual tree - let virtualization handle visibility
                node.children = this.convertToTreeNodes(topicTree[key], fullPath, depth + 1);
              }
              result.push(node);
            } else {
              // Deeper level - always add for virtual tree
              if (hasChildren) {
                node.children = this.convertToTreeNodes(topicTree[key], fullPath, depth + 1);
              }
              result.push(node);
            }
          }

          // Return frozen object to prevent Vue reactivity overhead
          return Object.freeze(result.map(node => this.freezeNodeRecursively(node)));
        },

        // Recursively freeze tree nodes for performance
        freezeNodeRecursively(node) {
          const frozenNode = { ...node };
          if (frozenNode.children) {
            frozenNode.children = Object.freeze(
              frozenNode.children.map(child => this.freezeNodeRecursively(child))
            );
          }
          return Object.freeze(frozenNode);
        },

        // Handle node selection in the PrimeVue tree
        onNodeSelect(event) {
          const node = event.node;

          // In PrimeVue, the event contains the node object
          if (!node) {
            console.error('No node data in selection event');
            return;
          }

          // Get topic path from the node data
          const topicPath = node.data;
          if (!topicPath) {
            console.error('No path data in selected node');
            return;
          }

          // Display the payload if we have data for this topic
          if (this.topicData[topicPath]) {
            this.displayPayload(this.topicData[topicPath]);
          } else {
            // Check if we need to add a leading slash
            const altPath = topicPath.startsWith('/') ? topicPath.substring(1) : '/' + topicPath;

            if (this.topicData[altPath]) {
              this.displayPayload(this.topicData[altPath]);
            } else {
              // Always normalize the selected topic to ensure consistent comparison
              this.selectedTopic = this.normalizeTopic(topicPath);
              this.selectedPayload = null;
              this.selectedTimestamp = '';
            }
          }

          // Update the chart for the selected topic
          this.updateChart();
        },

        // Display payload for a selected topic
        displayPayload(message) {
          if (!message) {
            console.warn('No message data provided to displayPayload');
            return;
          }

          // Always normalize the selected topic to ensure consistent comparison
          this.selectedTopic = this.normalizeTopic(message.topic);
          this.selectedPayload = message.payload;

          // Format timestamp
          const timestamp = new Date(message.timestamp).toLocaleString();
          this.selectedTimestamp = timestamp;

          // Update available properties for charting if payload is an object
          this.updateAvailableProperties(message.payload);
        },

        // Update available properties for charting
        updateAvailableProperties(payload) {
          this.availableProperties = [];

          // Extract properties from the payload
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            // Get all properties
            const properties = Object.keys(payload);

            // Filter out non-primitive properties and known timestamp fields
            const filteredProps = properties.filter(prop => {
              const value = payload[prop];
              const type = typeof value;
              // Include primitives and exclude common timestamp fields
              return (type === 'number' || type === 'boolean' || type === 'string') &&
                !prop.toLowerCase().includes('timestamp') &&
                !prop.toLowerCase().includes('time') &&
                !prop.toLowerCase().includes('date');
            });

            this.availableProperties = filteredProps;

            // Set a default property if none selected
            if (filteredProps.length > 0 && !filteredProps.includes(this.selectedProperty)) {
              // Prioritize 'value', 'presentValue', 'state' properties
              const priorityProps = ['value', 'presentValue', 'state', 'temp', 'temperature'];

              for (const prop of priorityProps) {
                if (filteredProps.includes(prop)) {
                  this.selectedProperty = prop;
                  break;
                }
              }

              // If no priority prop, use the first available
              if (!filteredProps.includes(this.selectedProperty)) {
                this.selectedProperty = filteredProps[0];
              }
            }
          }
        },

        // Format the payload based on its type
        formatPayload(payload) {
          if (payload === null || payload === undefined) {
            return '<em>empty</em>';
          }

          try {
            // If it's an object or JSON string, pretty print it
            if (typeof payload === 'object') {
              return `<pre>${this.escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
            }

            // If it's a string but might be JSON, try to parse and pretty print it
            if (typeof payload === 'string' &&
              (payload.startsWith('{') || payload.startsWith('[')) &&
              (payload.endsWith('}') || payload.endsWith(']'))) {
              try {
                const json = JSON.parse(payload);
                return `<pre>${this.escapeHtml(JSON.stringify(json, null, 2))}</pre>`;
              } catch (e) {
                // Not JSON, treat as string
                return this.escapeHtml(payload);
              }
            }

            // Regular string
            return this.escapeHtml(payload.toString());
          } catch (e) {
            return `<em>Error formatting payload</em>`;
          }
        },

        // Escape HTML to prevent XSS
        escapeHtml(text) {
          if (text === null || text === undefined) return '';
          return text.toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        },

        /**
         * Handles clicks on leaf topic nodes
         * @param {Object} node - Tree node object containing topic data
         */
        onChildTopicClick(node) {
          if (!node) return;

          const topicPath = node.data;
          if (!topicPath) return;

          // Handle child topic click - can add special behavior for leaf nodes here
          if (this.topicData[topicPath]) {
            this.displayPayload(this.topicData[topicPath]);
          } else {
            // Try alternative path format
            const altPath = topicPath.startsWith('/') ? topicPath.substring(1) : '/' + topicPath;

            if (this.topicData[altPath]) {
              this.displayPayload(this.topicData[altPath]);
            } else {
              // For leaf nodes without data, show the topic but with null payload
              // This is different from an error - it's a valid topic that just hasn't received data yet
              // Always normalize the selected topic to ensure consistent comparison
              this.selectedTopic = this.normalizeTopic(topicPath);
              this.selectedPayload = null;
              this.selectedTimestamp = '';
            }
          }

          // Update the chart for the selected topic
          this.updateChart();
        },

        // Extract value from payload (handling any data type)
        extractValue(payload) {
          // Handle null/undefined
          if (payload === null || payload === undefined) {
            return null;
          }

          // Handle objects with the selected property
          if (typeof payload === 'object' && !Array.isArray(payload) && this.selectedProperty && payload[this.selectedProperty] !== undefined) {
            // Extract the selected property
            return this.normalizeValue(payload[this.selectedProperty]);
          }

          // Handle basic types directly
          return this.normalizeValue(payload);
        },

        // Normalize a value for charting
        normalizeValue(value) {
          if (value === null || value === undefined) {
            return null;
          }

          // Handle different data types
          if (typeof value === 'number') {
            return value;
          }

          if (typeof value === 'boolean') {
            return value ? 1 : 0; // Convert boolean to 1/0 for plotting
          }

          if (typeof value === 'string') {
            // Try to parse as number first
            if (this.isNumericString(value)) {
              return parseFloat(value);
            }

            // Handle boolean strings
            if (value.toLowerCase() === 'true') return 1;
            if (value.toLowerCase() === 'false') return 0;

            // Handle categorical string values
            if (this.isStringProperty && this.stringValueMap[value] !== undefined) {
              return this.stringValueMap[value];
            }

            // Return as is (will be categorical)
            return value;
          }

          // If it's a complex object, try to stringify
          if (typeof value === 'object') {
            return JSON.stringify(value);
          }

          // Default fallback
          return String(value);
        },

        // Check if a string is numeric
        isNumericString(str) {
          if (typeof str !== 'string') return false;
          return !isNaN(parseFloat(str)) && isFinite(str);
        },

        // Update chart with topic history data
        updateChart() {
          if (!this.selectedTopic || !this.topicHistory[this.selectedTopic]) {
            // Clear chart data if no topic selected
            this.chartLabels = [];
            this.chartValues = [];
            this.isStringProperty = false;
            // Let the chart system handle the empty data
            this.$nextTick(() => {
              this.renderChart();
            });
            return;
          }

          // Get history for the selected topic
          let history = [...this.topicHistory[this.selectedTopic]];

          // Filter based on time range
          const now = Date.now();
          if (this.chartTimeRange === 'hour') {
            history = history.filter(msg => (now - msg.timestamp) <= 3600000); // 1 hour
          } else if (this.chartTimeRange === 'minute') {
            history = history.filter(msg => (now - msg.timestamp) <= 60000); // 1 minute
          }

          // Reverse to get chronological order
          history = history.reverse();

          // Reset chart data (using local variables to avoid Vue reactivity issues)
          const chartLabels = [];
          const chartValues = [];
          let isStringProperty = false;
          const stringValueMap = {}; // Not reactive, just local

          // First pass: check if we're dealing with string values
          // and build the mapping table for string values
          let nextStringValue = 1;
          let allStringValues = new Set();

          history.forEach(msg => {
            if (!msg.payload || typeof msg.payload !== 'object') return;

            const rawValue = msg.payload[this.selectedProperty];
            if (typeof rawValue === 'string' && !this.isNumericString(rawValue)) {
              isStringProperty = true;
              if (!allStringValues.has(rawValue)) {
                allStringValues.add(rawValue);
              }
            }
          });

          // Create mapping for string values
          if (isStringProperty) {
            [...allStringValues].sort().forEach(val => {
              stringValueMap[val] = nextStringValue++;
            });
          }

          // Second pass: extract values using string mapping if needed
          history.forEach(msg => {
            // Add timestamp
            chartLabels.push(new Date(msg.timestamp).toLocaleTimeString());

            // Extract value based on selected property
            const value = this.extractValueWithMap(msg.payload, isStringProperty, stringValueMap);
            chartValues.push(value);
          });

          // Update Vue data (minimal reactive updates)
          this.chartLabels = chartLabels;
          this.chartValues = chartValues;
          this.isStringProperty = isStringProperty;

          // Render chart on next tick to ensure DOM is updated
          this.$nextTick(() => {
            this.renderChart(isStringProperty, stringValueMap);
          });
        },

        // Extract value with mapping
        extractValueWithMap(payload, isStringProperty, stringValueMap) {
          // Handle null/undefined
          if (payload === null || payload === undefined) {
            return null;
          }

          // Handle objects with the selected property
          if (typeof payload === 'object' && !Array.isArray(payload) &&
            this.selectedProperty && payload[this.selectedProperty] !== undefined) {
            return this.normalizeValueWithMap(
              payload[this.selectedProperty],
              isStringProperty,
              stringValueMap
            );
          }

          // Handle basic types directly
          return this.normalizeValueWithMap(
            payload,
            isStringProperty,
            stringValueMap
          );
        },

        // Normalize a value for charting with mapping
        normalizeValueWithMap(value, isStringProperty, stringValueMap) {
          if (value === null || value === undefined) {
            return null;
          }

          // Handle different data types
          if (typeof value === 'number') {
            return value;
          }

          if (typeof value === 'boolean') {
            return value ? 1 : 0; // Convert boolean to 1/0 for plotting
          }

          if (typeof value === 'string') {
            // Try to parse as number first
            if (this.isNumericString(value)) {
              return parseFloat(value);
            }

            // Handle boolean strings
            if (value.toLowerCase() === 'true') return 1;
            if (value.toLowerCase() === 'false') return 0;

            // Handle categorical string values
            if (isStringProperty && stringValueMap[value] !== undefined) {
              return stringValueMap[value];
            }

            // Return as is (will be categorical)
            return value;
          }

          // If it's a complex object, try to stringify
          if (typeof value === 'object') {
            return JSON.stringify(value);
          }

          // Default fallback
          return String(value);
        },

        // Start heartbeat to detect disconnections
        startHeartbeat() {
          // Clear any existing interval
          if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
          }

          // Set last heartbeat time
          this.lastHeartbeat = Date.now();

          // Start heartbeat interval (check every 5 seconds)
          this.heartbeatInterval = setInterval(() => {
            // Only check if socket exists and should be connected
            if (this.socket) {
              if (this.socket.connected && Date.now() - this.lastHeartbeat > 10000) {
                this.reconnectSocket();
              }

              // If socket is supposedly connected, ping the server
              if (this.socket.connected) {
                this.socket.emit('ping', () => {
                  // Update heartbeat time when we get a response
                  this.lastHeartbeat = Date.now();
                });
              }
            }
          }, 5000);
        },

        // Stop heartbeat
        stopHeartbeat() {
          if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
          }
        },

        // Force reconnection
        reconnectSocket() {
          if (this.socket) {
            // Close the current connection
            this.socket.close();

            // Schedule a reconnection attempt after a short delay
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
            }

            this.reconnectTimer = setTimeout(() => {
              this.socket.connect();
            }, 1000);
          }
        },

        // Render chart - completely isolated from Vue's reactivity
        renderChart(isStringProperty, stringValueMap) {
          try {
            // Check if there's an existing Chart instance on the window object
            if (window.mqttChart && typeof window.mqttChart === 'object' && typeof window.mqttChart.destroy === 'function') {
              window.mqttChart.destroy();
              window.mqttChart = null;
            }

            const canvas = document.getElementById('mqttChart');
            if (!canvas) return;

            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            // Create y-axis configuration
            const yAxisConfig = {
              title: {
                display: true,
                text: this.selectedProperty || 'Value'
              },
              beginAtZero: false
            };

            // Create a non-reactive local copy of the data
            const chartData = {
              labels: [...this.chartLabels],
              datasets: [{
                label: this.selectedProperty || this.selectedTopic || 'Topic Value',
                data: [...this.chartValues],
                borderColor: '#3B82F6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                tension: 0.2,
                fill: true,
                pointRadius: isStringProperty ? 5 : 3
              }]
            };

            // Set up tick callbacks for string values
            if (isStringProperty && stringValueMap) {
              // Create reversed mapping (numeric to string)
              const reversedMap = {};
              for (const [key, value] of Object.entries(stringValueMap)) {
                reversedMap[value] = key;
              }

              // Add custom ticks
              yAxisConfig.ticks = {
                callback: function (value) {
                  return reversedMap[value] || value;
                },
                stepSize: 1
              };
            }

            // Create tooltip callbacks
            const tooltipCallbacks = {
              label: function (context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }

                if (isStringProperty && stringValueMap) {
                  // Find the original string value
                  const numValue = context.parsed.y;
                  for (const [strValue, mappedValue] of Object.entries(stringValueMap)) {
                    if (mappedValue === numValue) {
                      return label + strValue;
                    }
                  }
                }

                if (context.parsed.y !== null) {
                  label += context.parsed.y;
                }
                return label;
              }
            };

            // Create a new Chart instance
            window.mqttChart = new Chart(ctx, {
              type: 'line',
              data: chartData,
              options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                  duration: 500
                },
                scales: {
                  x: {
                    title: {
                      display: true,
                      text: 'Time'
                    }
                  },
                  y: yAxisConfig
                },
                plugins: {
                  legend: {
                    display: true,
                    position: 'top'
                  },
                  tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: tooltipCallbacks
                  }
                }
              }
            });
          } catch (e) {
            // Chart rendering failed silently
          }
        },

        // Handle node expansion for lazy loading
        onNodeExpand(event) {
          const node = event.node;
          if (!node || !node.key) return;

          this.expandedNodeKeys[node.key] = true;

          if (node.hasLazyChildren) {
            this.treeNodes = this.convertToTreeNodes(this.persistentTreeStructure);
          }
        },

        /**
         * Handles node collapse events in the tree
         * @param {Object} event - Tree collapse event
         */
        onNodeCollapse(event) {
          const node = event.node;
          if (!node || !node.key) return;

          this.expandedNodeKeys[node.key] = false;
        },



        // Toggle node expansion for virtual tree
        toggleNode(node) {
          if (!node.leaf) {
            if (this.expandedNodeKeys[node.key]) {
              this.onNodeCollapse({ node });
            } else {
              this.onNodeExpand({ node });
            }
          }
        },

        /**
         * Handles page visibility changes for background tab optimization
         */
        handleVisibilityChange() {
          const wasVisible = this.isPageVisible;
          this.isPageVisible = !document.hidden;

          if (!this.isPageVisible) {
            this.hiddenStartTime = Date.now();
            this.wasHiddenLongTime = false;
            this.stopHeartbeat();
            this.startBackgroundHeartbeat();
          } else if (wasVisible === false) {
            const hiddenDuration = Date.now() - (this.hiddenStartTime || 0);
            this.wasHiddenLongTime = hiddenDuration > 30000;

            this.stopBackgroundHeartbeat();
            this.startHeartbeat();

            if (this.wasHiddenLongTime) {
              this.forceReconnection();
            }

            setTimeout(() => {
              this.hiddenStartTime = null;
              this.wasHiddenLongTime = false;
            }, 4000);
          }
        },

        /**
         * Starts background heartbeat with longer intervals for hidden tabs
         */
        startBackgroundHeartbeat() {
          this.stopBackgroundHeartbeat();

          backgroundReconnectTimer = setInterval(() => {
            if (this.socket && this.socket.connected) {
              this.socket.emit('ping', () => { });
            } else if (this.socket) {
              this.socket.connect();
            }
          }, 30000);
        },

        // Stop background heartbeat
        stopBackgroundHeartbeat() {
          if (backgroundReconnectTimer) {
            clearInterval(backgroundReconnectTimer);
            backgroundReconnectTimer = null;
          }
        },

        /**
         * Forces WebSocket reconnection to sync latest data
         */
        forceReconnection() {
          if (this.socket) {
            this.socket.disconnect();
            setTimeout(() => {
              if (this.socket) {
                this.socket.connect();
              }
            }, 1000);
          }
        },

        /**
         * Requests data synchronization from server after being hidden
         */
        requestDataSync() {
          if (this.socket && this.socket.connected) {
            this.socket.emit('request-sync', {
              clientVisible: true,
              lastSync: this.hiddenStartTime || Date.now() - 60000
            });
          }
        },

        // Enhanced setup with visibility handling
        setupPageVisibilityHandling() {
          // Set up page visibility change handler
          visibilityChangeHandler = () => this.handleVisibilityChange();

          // Add event listener for visibility changes
          document.addEventListener('visibilitychange', visibilityChangeHandler);

          // Also listen for window focus/blur as backup
          window.addEventListener('focus', () => {
            if (document.hidden === false) {
              this.handleVisibilityChange();
            }
          });

          window.addEventListener('blur', () => {
            // Small delay to let visibilitychange fire first
            setTimeout(() => {
              if (document.hidden === true) {
                this.handleVisibilityChange();
              }
            }, 100);
          });

          this.isPageVisible = !document.hidden;
        },

        // Clean up visibility handling
        cleanupPageVisibilityHandling() {
          if (visibilityChangeHandler) {
            document.removeEventListener('visibilitychange', visibilityChangeHandler);
            visibilityChangeHandler = null;
          }

          this.stopBackgroundHeartbeat();
        },
      },
      mounted() {
        this.setupWebSocket();
        this.startHeartbeat();
        this.startMemoryChecks();
        this.setupPageVisibilityHandling();
      },

      beforeUnmount() {
        // Clean up chart instance
        if (window.mqttChart && typeof window.mqttChart === 'object' && typeof window.mqttChart.destroy === 'function') {
          try {
            window.mqttChart.destroy();
            window.mqttChart = null;
          } catch (e) {
            // Chart cleanup failed silently
          }
        }

        // Clean up socket and intervals
        this.stopHeartbeat();
        this.stopMemoryChecks();
        this.cleanupPageVisibilityHandling();

        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
        }

        if (this.socket) {
          this.socket.disconnect();
        }

        if (this.resizeObserver) {
          this.resizeObserver.disconnect();
        }
      }
    });

    // Register components
    app.component('virtual-tree', VirtualTree);

    // Mount Vue app
    app.mount('#app');
  }
})(); 