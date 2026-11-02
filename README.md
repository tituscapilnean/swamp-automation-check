# @tituscapilnean/automation-check

Health checks for live swamp automations. A scheduled workflow can "succeed"
while producing bad output: an API quietly changes, a source returns nothing, a
parser stops matching. This behavior checks the output itself, records the
result every run, and fails the run when something is wrong, so the schedule
turns red instead of shipping bad data.

## How it works

Each instance lists one or more **targets**. A target names another behavior's
data item and a set of **checks**. Each check is a CEL predicate (true = pass)
with a severity:

- `error`: a failure fails the run (unless `failOnError: false`)
- `warn`: recorded and logged, the run still passes

Variables available to every check:

| Variable      | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| `current`     | the target data's attributes, latest version                      |
| `previous`    | the version before it, or `{}` when there is none                 |
| `hasPrevious` | whether `previous` exists                                         |
| `ageHours`    | hours since `timestampField` in `current`, or `-1` when not set   |

Built in, without writing a check:

- **data-exists**: missing data is always an error
- **fresh**: with `timestampField` and `maxAgeHours`, stale data is an error

One instance checks all its targets in a single run (fan-out), and writes one
`summary` record: `passed`, `errorCount`, `warnCount`, and per-target results.

## Example

```yaml
type: '@tituscapilnean/automation-check'
name: lead-sync-health
globalArguments:
  failOnError: true
  targets:
    - behavior: lead-sync
      dataName: current
      timestampField: syncedAt
      maxAgeHours: 26
      checks:
        - name: leads-synced
          expr: current.leadCount > 0
          message: The sync returned no leads
        - name: few-sync-errors
          severity: warn
          expr: size(current.errors) <= 3
        - name: volume-stable
          severity: warn
          expr: "!hasPrevious || current.leadCount * 10 >= previous.leadCount * 7"
          message: Lead volume dropped more than 30% since the previous run
```

Add it as the last step of the automation's swamp workflow, after the steps it
checks, with `allowFailure: false` so a failed check fails the workflow.

```yaml
jobs:
  - name: main
    steps:
      - name: sync
        task: { type: model_method, modelIdOrName: lead-sync, methodName: sync }
        allowFailure: true
      - name: health
        task: { type: model_method, modelIdOrName: lead-sync-health, methodName: run }
        dependsOn:
          - step: sync
            condition: { type: completed }
        allowFailure: false
```

Read the latest results with
`swamp data query 'modelName == "lead-sync-health" && name == "summary"' --select content`.

## Writing good checks

- Check **coverage** (how many sources answered), **volume** (how many records),
  **errors** (how many sources failed), and **change since last run**. Those four
  catch most silent failures.
- Use integer arithmetic for ratios (`a * 10 >= b * 7`, not `a >= b * 0.7`).
- Guard nullable fields (`current.x != null && current.x > 0`).
- A check whose expression throws (for example a misspelled field) fails, with
  the error recorded, so typos surface instead of passing silently.
