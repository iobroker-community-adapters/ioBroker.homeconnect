# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

## Adapter-Specific Context
- **Adapter Name**: homeconnect
- **Primary Function**: Home Connect API integration for BSH appliances (Bosch, Siemens, Neff)
- **Key Dependencies**: axios, eventsource, tough-cookie (OAuth2 API communication)
- **Configuration**: Requires OAuth2 ClientID from https://developer.home-connect.com
- **Target Devices**: BSH home appliances (dishwashers, ovens, washing machines, refrigerators, etc.)
- **API Features**: Real-time events via Server-Sent Events, device control, status monitoring
- **Authentication**: OAuth2 flow with refresh token management
- **Rate Limiting**: Uses axios-rate-limit for API throttling per BSH requirements

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties
                        Object.assign(obj.native, {
                            position: TEST_COORDINATES,
                            createCurrently: true,
                            createHourly: true,
                            createDaily: true,
                            // Add other configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Check that expected states were created
                        const states = await harness.states.getKeysAsync('your-adapter.0.*');
                        
                        if (states.length === 0) {
                            return reject(new Error('No states created by adapter'));
                        }

                        console.log(`✅ Found ${states.length} states created by adapter`);
                        resolve();
                        
                    } catch (err) {
                        console.error('❌ Test failed:', err.message);
                        reject(err);
                    }
                });
            }).timeout(30000);
        });
    }
});
```

### Testing Integration with API Services

For adapters that integrate with external APIs (like weather services, IoT platforms, etc.), use these patterns:

#### Testing Without Live API Access
```javascript
// Mock API responses for testing
const mockApiResponse = require('./fixtures/api-responses.json');

// Mock axios or your HTTP client
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

beforeEach(() => {
  mockedAxios.get.mockResolvedValue({
    data: mockApiResponse
  });
});
```

#### Testing OAuth Flows
```javascript
// Test OAuth token refresh
it('should refresh expired tokens', async () => {
  const expiredToken = 'expired_token';
  const newToken = 'new_token';
  
  mockedAxios.post.mockResolvedValueOnce({
    data: { access_token: newToken, expires_in: 3600 }
  });
  
  const result = await adapter.refreshToken(expiredToken);
  expect(result).toBe(newToken);
});
```

### HomeConnect API Specific Testing Patterns
```javascript
// Test Home Connect OAuth flow
it('should complete OAuth authorization flow', async () => {
  const mockAuthCode = 'mock_auth_code';
  const mockTokenResponse = {
    access_token: 'mock_access_token',
    refresh_token: 'mock_refresh_token',
    expires_in: 3600
  };
  
  mockedAxios.post.mockResolvedValueOnce({ data: mockTokenResponse });
  
  await adapter.exchangeCodeForToken(mockAuthCode);
  expect(adapter.accessToken).toBe(mockTokenResponse.access_token);
});

// Test device discovery
it('should discover Home Connect appliances', async () => {
  const mockDevices = [
    { haId: 'BOSCH-HCS02DWH1-68A40E239DE8', name: 'Dishwasher', type: 'Dishwasher' }
  ];
  
  mockedAxios.get.mockResolvedValueOnce({ data: { data: { homeappliances: mockDevices } } });
  
  const devices = await adapter.discoverDevices();
  expect(devices).toHaveLength(1);
  expect(devices[0].type).toBe('Dishwasher');
});
```

## Error Handling and Logging

### Structured Error Handling
```javascript
try {
  await this.apiCall();
} catch (error) {
  if (error.response?.status === 401) {
    this.log.warn('API authentication failed, attempting token refresh');
    await this.refreshToken();
  } else if (error.response?.status === 429) {
    this.log.warn('API rate limit reached, backing off');
    await this.delay(error.response.headers['retry-after'] * 1000);
  } else {
    this.log.error(`Unexpected API error: ${error.message}`);
  }
}
```

### Logging Best Practices
- Use appropriate log levels: `error`, `warn`, `info`, `debug`
- Include context in log messages
- Log important state changes
- Use debug level for verbose API communication logs

### HomeConnect API Error Handling
```javascript
// Handle Home Connect specific errors
handleApiError(error) {
  const status = error.response?.status;
  const errorCode = error.response?.data?.error?.key;
  
  switch (status) {
    case 401:
      this.log.warn('Home Connect authentication expired, refreshing token');
      return this.refreshToken();
    case 409:
      if (errorCode === 'BSH.Common.Error.PowerOffState') {
        this.log.info('Appliance is powered off, cannot execute command');
      }
      break;
    case 429:
      this.log.warn('Home Connect rate limit exceeded, backing off');
      break;
    default:
      this.log.error(`Home Connect API error: ${error.message}`);
  }
}
```

## API Integration Patterns

### RESTful API Integration
```javascript
async apiRequest(endpoint, method = 'GET', data = null) {
  try {
    const response = await this.httpClient.request({
      method,
      url: `${this.baseUrl}${endpoint}`,
      data,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/vnd.bsh.sdk.v1+json'
      }
    });
    return response.data;
  } catch (error) {
    this.handleApiError(error);
    throw error;
  }
}
```

### WebSocket/Server-Sent Events
```javascript
initializeEventStream() {
  const eventSource = new EventSource(`${this.baseUrl}/api/homeappliances/events`, {
    headers: { 'Authorization': `Bearer ${this.accessToken}` }
  });
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      this.handleDeviceEvent(data);
    } catch (error) {
      this.log.error(`Failed to parse event data: ${error.message}`);
    }
  };
  
  eventSource.onerror = (error) => {
    this.log.error('Event stream error:', error);
    this.reconnectEventStream();
  };
}
```

### HomeConnect Event Stream Pattern
```javascript
// Handle Home Connect Server-Sent Events
setupEventStream() {
  this.eventSource = new EventSource(
    `https://api.home-connect.com/api/homeappliances/events`,
    {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'text/event-stream'
      }
    }
  );
  
  this.eventSource.addEventListener('STATUS', (event) => {
    const data = JSON.parse(event.data);
    this.updateDeviceState(data.haId, data.items);
  });
  
  this.eventSource.addEventListener('EVENT', (event) => {
    const data = JSON.parse(event.data);
    this.handleDeviceEvent(data.haId, data.items);
  });
}
```

## State Management

### State Creation and Updates
```javascript
// Create states with proper metadata
async createState(id, name, type, role, unit = '', writable = false) {
  await this.setObjectNotExistsAsync(id, {
    type: 'state',
    common: {
      name,
      type,
      role,
      read: true,
      write: writable,
      unit
    },
    native: {}
  });
}

// Update states with proper value conversion
async updateState(id, value, ack = true) {
  const obj = await this.getObjectAsync(id);
  if (!obj) return;
  
  // Convert value based on state type
  let convertedValue = value;
  if (obj.common.type === 'boolean') {
    convertedValue = Boolean(value);
  } else if (obj.common.type === 'number') {
    convertedValue = Number(value);
  }
  
  await this.setStateAsync(id, convertedValue, ack);
}
```

### HomeConnect State Management
```javascript
// Create Home Connect appliance states
async createApplianceStates(haId, appliance) {
  const basePath = `appliances.${haId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  
  // Create device info states
  await this.createState(`${basePath}.info.name`, 'Name', 'string', 'info.name');
  await this.createState(`${basePath}.info.type`, 'Type', 'string', 'info.type');
  await this.createState(`${basePath}.info.connected`, 'Connected', 'boolean', 'indicator.connected');
  
  // Create control states
  await this.createState(`${basePath}.control.power`, 'Power', 'boolean', 'switch.power', '', true);
  await this.createState(`${basePath}.control.start`, 'Start Program', 'boolean', 'button.start', '', true);
}
```

## JSON Config Integration

### Configuration Schema
```javascript
// Define configuration schema in io-package.json
"jsonConfig": {
  "panel": {
    "title": "HomeConnect Configuration"
  },
  "items": {
    "client_id": {
      "type": "text",
      "label": "Client ID",
      "help": "OAuth2 Client ID from Home Connect Developer Portal"
    },
    "client_secret": {
      "type": "password",
      "label": "Client Secret",
      "help": "OAuth2 Client Secret"
    },
    "simulation_mode": {
      "type": "checkbox",
      "label": "Use Simulation Mode",
      "help": "Connect to Home Connect simulation API instead of production"
    }
  }
}
```

### Configuration Validation
```javascript
// Validate configuration on adapter start
validateConfig() {
  if (!this.config.client_id) {
    this.log.error('Client ID is required');
    return false;
  }
  
  if (!this.config.client_secret) {
    this.log.error('Client Secret is required');
    return false;
  }
  
  return true;
}
```

## Lifecycle Management

### Adapter Initialization
```javascript
async onReady() {
  try {
    // Validate configuration
    if (!this.validateConfig()) {
      return;
    }
    
    // Initialize HTTP client with rate limiting
    this.initializeHttpClient();
    
    // Load stored tokens
    await this.loadTokens();
    
    // Start main adapter logic
    await this.main();
    
  } catch (error) {
    this.log.error(`Initialization failed: ${error.message}`);
    this.terminate();
  }
}
```

### Resource Cleanup
```javascript
async unload(callback) {
  try {
    // Close event streams
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    
    // Clear intervals and timeouts
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    // Close HTTP connections
    if (this.httpClient) {
      await this.httpClient.destroy?.();
    }
    
    this.log.info('Adapter stopped and resources cleaned up');
    callback();
    
  } catch (error) {
    this.log.error(`Cleanup error: ${error.message}`);
    callback();
  }
}
```

### HomeConnect OAuth Management
```javascript
// Handle OAuth token lifecycle
async loadTokens() {
  const state = await this.getStateAsync('info.connection');
  if (state?.val) {
    this.accessToken = await this.getStateAsync('oauth.access_token');
    this.refreshToken = await this.getStateAsync('oauth.refresh_token');
  }
}

async saveTokens(accessToken, refreshToken) {
  await this.setStateAsync('oauth.access_token', accessToken, true);
  await this.setStateAsync('oauth.refresh_token', refreshToken, true);
  this.accessToken = accessToken;
  this.refreshToken = refreshToken;
}

async refreshAccessToken() {
  if (!this.refreshToken) {
    throw new Error('No refresh token available');
  }
  
  const response = await this.httpClient.post('/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: this.refreshToken,
    client_id: this.config.client_id,
    client_secret: this.config.client_secret
  });
  
  await this.saveTokens(response.data.access_token, response.data.refresh_token);
}
```

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

## CI/CD and Testing Integration

### GitHub Actions for API Testing
For adapters with external API dependencies, implement separate CI/CD jobs:

```yaml
# Tests API connectivity with demo credentials (runs separately)
demo-api-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run demo API tests
      run: npm run test:integration-demo
```

### CI/CD Best Practices
- Run credential tests separately from main test suite
- Use ubuntu-22.04 for consistency
- Don't make credential tests required for deployment
- Provide clear failure messages for API connectivity issues
- Use appropriate timeouts for external API calls (120+ seconds)

### Package.json Script Integration
Add dedicated script for credential testing:
```json
{
  "scripts": {
    "test:integration-demo": "mocha test/integration-demo --exit"
  }
}
```

### Practical Example: Complete API Testing Implementation
Here's a complete example based on lessons learned from the Discovergy adapter:

#### test/integration-demo.js
```javascript
const path = require("path");
const { tests } = require("@iobroker/testing");

// Helper function to encrypt password using ioBroker's encryption method
async function encryptPassword(harness, password) {
    const systemConfig = await harness.objects.getObjectAsync("system.config");
    
    if (!systemConfig || !systemConfig.native || !systemConfig.native.secret) {
        throw new Error("Could not retrieve system secret for password encryption");
    }
    
    const secret = systemConfig.native.secret;
    let result = '';
    for (let i = 0; i < password.length; ++i) {
        result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ password.charCodeAt(i));
    }
    
    return result;
}

// Run integration tests with demo credentials
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("API Testing with Demo Credentials", (getHarness) => {
            let harness;
            
            before(() => {
                harness = getHarness();
            });

            it("Should connect to API and initialize with demo credentials", async () => {
                console.log("Setting up demo credentials...");
                
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                
                const encryptedPassword = await encryptPassword(harness, "demo_password");
                
                await harness.changeAdapterConfig("your-adapter", {
                    native: {
                        username: "demo@provider.com",
                        password: encryptedPassword,
                        // other config options
                    }
                });

                console.log("Starting adapter with demo credentials...");
                await harness.startAdapter();
                
                // Wait for API calls and initialization
                await new Promise(resolve => setTimeout(resolve, 60000));
                
                const connectionState = await harness.states.getStateAsync("your-adapter.0.info.connection");
                
                if (connectionState && connectionState.val === true) {
                    console.log("✅ SUCCESS: API connection established");
                    return true;
                } else {
                    throw new Error("API Test Failed: Expected API connection to be established with demo credentials. " +
                        "Check logs above for specific API errors (DNS resolution, 401 Unauthorized, network issues, etc.)");
                }
            }).timeout(120000);
        });
    }
});
```

### HomeConnect API Integration Testing
```javascript
// Test Home Connect API integration with simulation mode
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("Home Connect API Testing", (getHarness) => {
            let harness;
            
            before(() => {
                harness = getHarness();
            });

            it("Should connect to Home Connect simulation API", async () => {
                console.log("Setting up Home Connect simulation credentials...");
                
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                
                await harness.changeAdapterConfig("homeconnect", {
                    native: {
                        client_id: "test_client_id",
                        client_secret: "test_client_secret",
                        simulation_mode: true,
                        // OAuth flow would be handled separately in real implementation
                    }
                });

                console.log("Starting homeconnect adapter...");
                await harness.startAdapter();
                
                // Wait for initialization and potential device discovery
                await new Promise(resolve => setTimeout(resolve, 30000));
                
                const connectionState = await harness.states.getStateAsync("homeconnect.0.info.connection");
                
                if (connectionState && connectionState.val === true) {
                    console.log("✅ SUCCESS: Home Connect API connection established");
                    
                    // Check for discovered appliances
                    const states = await harness.states.getKeysAsync("homeconnect.0.appliances.*");
                    console.log(`Found ${states.length} appliance-related states`);
                    
                    return true;
                } else {
                    throw new Error("Home Connect API Test Failed: Could not establish connection to simulation API");
                }
            }).timeout(120000);
        });
    }
});
```