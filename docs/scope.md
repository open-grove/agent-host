# Scope and acceptance

## Outcome

A developer can add a native Agent to a product without installing the OpenGrove desktop product or implementing its Rooms, Employees, knowledge vault, account service or business stores.

The independent repository owns the reusable integration. OpenGrove and a small file-editor product are consumers of its public package API.

## Public boundary

The product supplies:

- The chosen runtime, workspace and explicitly selected model/provider configuration.
- Stable instructions, current product context and user input as separate inputs.
- Product tool definitions and execution handlers, with explicit scope and cancellation.
- Handlers for permissions and structured questions.
- Storage for Host-to-native session bindings and product-visible events.

The integration provides:

- Session creation and continuation, turn execution and terminal outcomes.
- Correlated text, tool, interaction and lifecycle events.
- Cancellation, failure propagation and explicit recovery outcomes.
- Negotiated optional native controls and their verification status.

Private credentials stay at the runtime/Host boundary. Products may supply credential references or runtime configuration; browser examples must not expose Host or provider credentials.

## Ownership

| Concern | Owner |
| --- | --- |
| Model loop, native transcript, native tools, native compaction | Kernel |
| Transport, session binding, event translation, interaction routing | Agent Host adapter |
| Business tools, application authorization, UI and domain data | Consuming product |
| Durable product event storage and session-binding storage | Product-selected storage implementation |
| Process or sandbox provisioning | Selected environment/backend implementation |

Room, Employee, App Store, long-term memory strategy, billing, multi-tenant scheduling and cross-Agent collaboration are outside this extraction. This does not exclude their use by a consuming product.

## Kernel upgrades

All existing integrations remain in scope. For each Kernel:

1. Identify the current integration baseline and the latest stable upstream target.
2. Review the intervening public interfaces, release notes and implementation. A new CLI screen or command is not automatically an embeddable capability.
3. Classify relevant changes: required compatibility repair, newly exposed optional capability, or a feature with no supported integration surface.
4. Update the adapter and add behavior tests for lifecycle, interaction and recovery changes.
5. Run native probes in an isolated workspace and record the exact Kernel, adapter and provider context.
6. Publish the supported capability matrix, including unsupported or unverified paths.

Priorities include native continuation, cancellation outcomes, tool progress and results, approvals/questions, model/provider controls, context delivery and compaction. Runtime-specific features remain optional extensions instead of being simulated as universally supported.

An upstream release, a dependency version bump or a mocked test alone does not establish native support.

## Rivet evaluation

Evaluate Rivet through the same public boundary and acceptance suite. Existing ACP event projection and MCP tool bridging are reuse candidates. Verify workspace/tool connectivity separately for local and remote execution.

Do not equate event replay, restoration of a native conversation, and recovery of an interrupted side-effecting operation. Report whether a session was restored or recreated. Do not silently replay a product tool with external effects after reconnecting.

## Acceptance gates

### Independent distribution

- Install the built archive in a consumer outside this repository.
- No imports from OpenGrove source or dependency on its business stores.
- Public types, runtime files, license and required assets are included in the archive.
- OpenGrove consumes that package rather than retaining a second divergent adapter implementation.

### Shared behavior

- Create a session, stream an answer and continue with a second turn.
- Execute a scoped product tool; ensure it is not executed twice by event projection.
- Approve and reject an operation through the product UI.
- Answer a native structured question where the adapter advertises support.
- Cancel while generating, waiting on a tool and waiting on an interaction; close all relevant pending state.
- Reopen the consumer and continue the native conversation when supported; identify recreation or failure explicitly.
- Handle process failure, missing credentials and unavailable models without an indefinitely pending turn.
- Preserve supported native controls, or explicitly document an unsupported capability.

### Two consumers

OpenGrove exercises existing workflows. A small file editor exercises the same API without OpenGrove concepts. Both use isolated example data for integration tests.

Mock/protocol tests and native model-backed probes are recorded separately. Platform support is limited to actually verified platforms; an installer build is not a runtime certification.

## Work sequence

1. Inventory reusable code and review the existing external-product and context-lifecycle proposals.
2. Extract one complete native execution path through the public boundary and run both consumers.
3. Migrate and update the remaining adapters one at a time, with separate extraction and upstream-compatibility changes where practical.
4. Compare the Rivet backend under the same gates and retain native paths where required capabilities differ.
5. Publish a versioned package only with installation instructions and an evidence-backed support matrix.
