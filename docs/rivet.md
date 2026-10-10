# Rivet Sandbox Agent backend decision

Rivet's [Sandbox Agent 0.5.2](https://www.npmjs.com/package/sandbox-agent/v/0.5.2) offers a daemon, ACP over HTTP, event persistence and sandbox providers. Those are useful provisioning and transport capabilities. This extraction retains its native adapters because the SDK's default recovery does not meet the native-continuation requirement.

In the [reviewed implementation](https://github.com/rivet-dev/agents/blob/43d7bb21/sandbox-agent/sdks/typescript/src/client.ts#L1175), `resumeSession` reuses an existing live binding. After a stale connection it calls `createRemoteSession`, stores the new native ID and queues serialized history for the next prompt. Its own [integration test](https://github.com/rivet-dev/agents/blob/43d7bb21/sandbox-agent/sdks/typescript/tests/integration.test.ts#L499) explicitly checks recreation and replay.

| Gate | Result |
| --- | --- |
| Reuse a live native binding | Present in the SDK |
| Restore the same native conversation after losing the connection | Default SDK path creates another native session |
| Recover an interrupted side-effecting task without replaying effects | Not established by history replay |
| Preserve current native controls and structured interactions for all seven Kernels | Not established; generic ACP transport does not supply absent native semantics |
| Reuse sandbox provisioning / ACP transport independently | Possible future backend boundary; not required by these two local consumers |

The reproducible evaluation runs the **published SDK's actual recovery method**, replacing only its ACP connection with a deterministic seam. It checks the changed native ID and history replay, then checks live-binding reuse. It does not certify the daemon, sandbox providers or remote tool connectivity:

```sh
npm install --prefix .local/rivet-eval --ignore-scripts --omit=optional --omit=peer sandbox-agent@0.5.2
AGENT_HOST_RIVET_MODULE="$PWD/.local/rivet-eval/node_modules/sandbox-agent/dist/index.js" node scripts/evaluate-rivet.mjs
```

A future Rivet backend can be added when it either restores the original native conversation or explicitly reports recreation as a different outcome. It must also prove callback connectivity, interruption handling and authorization with the same consumer tests. Setting replay limits to zero does not turn recreation into native restoration.
