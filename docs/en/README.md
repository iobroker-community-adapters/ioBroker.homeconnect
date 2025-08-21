![Logo](admin/homeconnect.png)

# ioBroker.homeconnect

## Requirements before installation

- Node 20, 22 or 24
- JS-Controller >= 6.0.11
- Admin >= 7.4.10

A ClientID is required for the adapter. Use the settings for each step to register.

<https://developer.home-connect.com>

![Screenshot](img/registrierung1.JPG)

For **Default Home Connect User Account for Testing**, specify the e-mail address with which the Home Connect app is to be sent.
was registered, this is also required later in the authorization process.

![Screenshot](img/registrierung2.JPG)

For **Account Type** select Individual. Add the remaining data if available (no idea if this will be checked).

![Screenshot](img/application1.JPG)

Then go to **Applications** and then to **Register Application**.

![Screenshot](img/application2.JPG)

For **Application ID** enter a name for the application, e.g. ioBroker. With **OAuth Flow** Device Flow select.
**Home Connect User Account for Testing** can remain empty. For **Success Redirect** enter a URI, e.g. https://example.com.
Then save and you have the required ClientID.

## Configuration

Please add Homeconnect App username, password and generated cleintId into adapter config.

## Usage

With the states in commands you can stop, pause and resume a program.
With the states in settings you can turn off or turn on the device
Change the value of programs.active.BSH_Common_Root_ActiveProgram leads to starting a program
Update iQ300: You need to set the program name in this variable. If programs.selected.BSH_Common_Root_SelectedProgram is copied, the machine user can predefine the wanted program at the machine and it will be started via ioBroker
Change the value of programs.selected.BSH_Common_Root_SelectedProgram leads to selecting a program or options

## Rate Limiting

[API Rate Limiting](https://api-docs.home-connect.com/general/#rate-limiting)

- 10 event monitoring sessions per user and Home Connect account
  - not added
- 10 queries per second (this depends on the data volume)

  - not added

- 10 token refreshes per minute
  - Triggered after 9 requests within a minute. Then locked for 1 minute
- 109 token refreshes per day
  - Triggered after 99 requests within a day. Then locked until midnight. Not sure if it's actually 24 hours.

## homeconnect.0.rateTokenLimit.isBlocked

- true for lock and false for no lock

## homeconnect.0.rateTokenLimit.limitJson

```JSON
{
  "tokenRefreshMinutesMax": 9, // Max requests per 10 minutes
  "tokenRefreshMinutesCount": 0, // Counter for max requests per 10 minutes
  "tokenRefreshMinutesLast": 1754680202619, // Start time as a timestamp from which counting begins
  "tokenRefreshDayMax": 99, // Max requests per day
  "tokenRefreshDayCount": 2, // Counter for max requests per day
  "tokenRefreshDayLast": 1754658108428, // Start time as a timestamp from which counting begins
  "tokenBlock": false, // True if a lock is active
  "tokenBlockTime": 0, // Timestamp when the lock was triggered
  "tokenReason": "No Block" // Name of the lock (internal adapter)
}
```

## homeconnect.0.rateTokenLimit.reason

```JSON
    "states": {
      "0": "Nothing", // No lock
      "1": "Token Limit (10 per minute)", // 10 minute lock active
      "2": "Token Limit (100 per day)" // 24h active
    }
```

- 10 requests per second on average (20 requests max. burst) with leaky bucket algorithm

  - Triggered after 15 requests

- 1000 requests per client and Home Connect user account per day

  - Triggered after 9999 requests within one day. Then locked until midnight. I'm not sure if it's actually 24 hours.

- 50 requests per client and Home Connect user account per minute

  - Triggered after 49 requests within one minute. All queries are blocked for one minute.

- 5 Start requests per user and Home-Connect user account per minute

  - Triggered after 4 requests within one minute. All queries are blocked for 1 minute.

- 5 Stop requests per user and Home-Connect user account per minute

  - Triggered after 4 requests within one minute. All queries are blocked for 1 minute.

- 10 successive requests per client and Home Connect user account per 10 minutes
  - Triggered after 9 error messages within 10 minutes. All queries are blocked for 10 minutes.

## homeconnect.0.rateLimit.isBlocked

- true for lock and false for no lock

## homeconnect.0.rateLimit.limitJson

```JSON
{
  "requestsMinutesMax": 49, // Max requests per minute
  "requestsMinutesCount": 0, // Counter for max requests per minute
  "requestsMinutesLast": 1754680202594, // Start time as a timestamp from which counting begins
  "requestsDayMax": 999, // Max requests per day
  "requestsDayCount": 21, // Counter for max requests per day
  "requestsDayLast": 0, // Start time as a timestamp from which counting begins
  "requestsMinutesStartMax": 4, // Max start requests per minute
  "requestsMinutesStartCount": 0, // Counter for start requests per minute
  "requestsMinutesStartLast": 1754680202594, // Start time as a timestamp from which counting begins
  "requestsMinutesStopMax": 4, // Max stop requests per minute
  "requestsMinutesStopCount": 0, // Counter for stop requests per minute
  "requestsMinutesStopLast": 1754680202594, // Start time as a timestamp from which counting begins
  "responseErrorLast10MinutesMax": 9, // Max requests per 10 minutes
  "responseErrorLast10MinutesCount": 2, // Counter for max requests per 10 minutes
  "responseErrorLast10MinutesLast": 1754680143652, // Start time as a timestamp from which counting begins
  "requestBlock": false, // True if a lock is active
  "requestBlockTime": 0, // Timestamp when the lock was triggered
  "requestReason": "No Block", // Name of the lock (internal adapter)
  "requests": [ // All requests per day
    {
      "methode": "GET", // Methode
      "haId": "0000", // Serial number
      "url": "/status", // URL
      "date": "2025-08-14T18:46:17.535Z", // TIme
      "response": "OK" // OK == Kein Fehler / Error == Fehler
    },
    {
      "methode": "GET",
      "haId": "015030396331009276",
      "url": "/settings",
      "date": "2025-08-14T18:46:17.536Z",
      "response": "OK"
    },
  ],
}
```

## homeconnect.0.rateLimit.reason

```JSON
    "states": {
      "0": "Nothing", // No lock
      "1": "Error Limit (10 per 10 minutes)", // Error lock active for 10 minutes
      "2": "Start (5 per minute)", // Start lock active for 1 minute
      "3": "Stop Limit (5 per minute)", // Stop lock active for 1 minute
      "4": "Request Limit (50 per minute)", // Lock active for 1 minute
      "5": "Request Limit (1000 per day)" // Block for one day active
    }
```
