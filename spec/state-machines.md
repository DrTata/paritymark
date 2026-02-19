## Script State Machine

### States

- INGESTING – Script metadata and PageImages are being imported and validated.
- ASSEMBLED – Pages/Booklets for the Script are matched and structural checks pass.
- QC_PASSED – Quality checks (legibility, completeness, structure) passed.
- READY_FOR_ALLOCATION – Script is approved to feed Responses into the LIVE_POOL (Response state machine).
- IN_MARKING – At least one LIVE Response for this Script is ALLOCATED or IN_PROGRESS.
- SUSPENDED – Script is removed from LIVE workflows (e.g., investigation).
- COMPLETED – All required marking and review workflows for this Script have finished.
- LOCKED – Script is frozen (no further marking or structural changes).

### Valid Transitions

- INGESTING → ASSEMBLED  
  When structural assembly of the Script succeeds.

- ASSEMBLED → QC_PASSED  
  When QC checks complete successfully.

- QC_PASSED → READY_FOR_ALLOCATION  
  When the Script is accepted into LIVE marking.

- READY_FOR_ALLOCATION → IN_MARKING  
  When the first associated Response leaves LIVE_POOL and becomes ALLOCATED/IN_PROGRESS.

- IN_MARKING → COMPLETED  
  When all Responses for the Script are in final marking states (e.g., SUBMITTED or LOCKED in the Response state machine).

- READY_FOR_ALLOCATION → SUSPENDED  
  When the Script is held before marking (e.g., admin decision).

- IN_MARKING → SUSPENDED  
  When marking must be paused (e.g., investigation).

- SUSPENDED → READY_FOR_ALLOCATION  
  When the hold is lifted and marking can (re)start.

- COMPLETED → LOCKED  
  When results are finalized and Script is frozen.

### Invalid Transitions (must be rejected)

- Any transition out of LOCKED (LOCKED is final).
- COMPLETED → IN_MARKING (should be modeled as a new Script/Response workflow, e.g. remark, if allowed at all).
- Direct jumps that bypass required stages without a configuration flag (e.g., INGESTING → IN_MARKING, ASSEMBLED → IN_MARKING).

### Audit Requirements (Script)

Every Script state transition attempt MUST emit an AuditEvent:

- Required fields:
  - scriptId, candidateId, componentId
  - fromState, toState
  - result: SUCCESS or REJECTED
  - actor (system job, admin, TL, etc.)
  - reasonCode (mandatory for SUSPENDED and LOCKED)
  - timestamp

Rejected transitions MUST set `result = REJECTED` and include an errorCode (e.g. INVALID_STATE_TRANSITION).

## Allocation State Machine

Allocations track the lifecycle of the work contract between a Response and a Marker. Response state remains authoritative for marking progress; Allocation state describes how that work is assigned and managed.

### States

- READY – Allocation exists and is eligible to be taken or assigned, but work has not started.
- IN_MARKING – Allocation is active; the Response has been ALLOCATED/IN_PROGRESS for this Marker.
- SUSPENDED – Allocation is temporarily paused (e.g. marker suspension, Script exception).
- COMPLETED – Work associated with this Allocation has finished (e.g. Response SUBMITTED/LOCKED for this Marker).
- LOCKED – Allocation history is frozen; no further releases or reassignments.

### Valid Transitions

- READY → IN_MARKING  
  When the Response is assigned to the Marker (often coupled with Response: LIVE_POOL → ALLOCATED/IN_PROGRESS).

- IN_MARKING → COMPLETED  
  When the Marker submits or finalizes marks for this Response.

- READY → SUSPENDED  
  When work must be held before marking (eligibility or admin issue).

- IN_MARKING → SUSPENDED  
  When active marking must be paused.

- SUSPENDED → READY  
  When the issue is resolved and the Allocation becomes eligible again.

- COMPLETED → LOCKED  
  When Allocation history is finalized (e.g., post-results sign-off).

Admin/TL operations (with strict audit):

- IN_MARKING → READY (release) – allowed only with a reasonCode (e.g. marker overload, Script exception).
- IN_MARKING → COMPLETED (forced completion) – exceptional; MUST be audited and generally avoided in normal flows.

### Invalid Transitions (must be rejected)

- Any transition out of LOCKED.
- COMPLETED → IN_MARKING or COMPLETED → READY (should instead create a new Allocation if supported by configuration).
- Direct READY → COMPLETED transitions that skip IN_MARKING, unless explicitly allowed via a config-driven admin shortcut and heavily audited.

### Audit Requirements (Allocation)

Every Allocation state transition attempt MUST emit an AuditEvent:

- Required fields:
  - allocationId, responseId, scriptId, candidateId
  - markerId (if applicable)
  - fromState, toState
  - result: SUCCESS or REJECTED
  - actor (Marker, TL, PE, admin, system)
  - reasonCode (mandatory for releases, reassignments, suspensions)
  - timestamp

Rejected transitions MUST set `result = REJECTED` and include an errorCode (e.g. INVALID_ALLOCATION_TRANSITION or MARKER_NOT_ELIGIBLE).

## Traceability Acceptance Criteria (Objective 01)

For every PageImage, Response, MarkRecord, Annotation, and AuditEvent that participates in the marking workflow:

- ScriptID MUST be directly present or derivable via foreign keys.
- CandidateID MUST be derivable via Script (and MAY be duplicated for convenience, but Script remains the single source of truth).
- ComponentID MUST be present at Script and Response level.
- AllocationID and MarkerID MUST be present in any AuditEvent about allocation or marking.

Acceptance tests MUST demonstrate:

1. For a sample Script, all PageImages, Responses, MarkRecords, Annotations, and relevant AuditEvents can be navigated back to ScriptID and CandidateID.
2. Invalid Script or Allocation state transitions are rejected and produce REJECTED AuditEvents with appropriate error codes.
