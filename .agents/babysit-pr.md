# babysit-pr in this repository

## Checks

```json
{
  "workflows": [
    {
      "name": "CI",
      "checks": ["verify"],
      "rerunOn": ["failure", "cancelled", "timed_out", "action_required"]
    }
  ]
}
```

`live-gate` is a commit status that the `verify-open-pstack` skill publishes on each head; no workflow reruns it.
