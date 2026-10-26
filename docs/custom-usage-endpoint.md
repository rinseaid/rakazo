# Custom usage endpoint

In a saved model connection, expand **Custom usage endpoint** and enter an HTTP(S) URL. An optional bearer token belongs to this endpoint alone. The endpoint configuration is encrypted inline with the server encryption key and removed with its model connection. Changing the URL clears the previously saved token unless a new token is entered. Clearing the URL removes the setting. Authentication tokens require HTTPS. Network access follows the server's existing remote endpoint policy, including its private-network setting; redirects are refused.

The endpoint returns a JSON object with one to 32 uniquely named windows:

```json
{
  "windows": [
    { "id": "daily", "usedPercent": 35, "resetsAt": "2030-01-07T12:00:00.000Z" },
    { "id": "monthly", "usedPercent": 60 }
  ]
}
```

`usedPercent` is a number from 0 through 100. `resetsAt` is an optional ISO 8601 UTC timestamp or null. Unknown window names are shown as provided. The endpoint is read-only and does not supply an account identity, enable quota admission or change the model route. Rakazo limits responses to 64 KiB and requests to ten seconds. A failed read appears unavailable.
