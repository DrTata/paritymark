## Core Workflow Entities (Objective 01 – Workflow Foundations)

### Exam
Top-level assessment event (e.g. “June 2026 Maths”). Groups Components and Sessions. Does not itself carry marking configuration; that is defined at Component/QIG level.

### Component
Assessable unit within an Exam (e.g. “Paper 1”, “Biology Unit 2”). Carries the ComponentID and is the anchor for QIG-level marking configuration, seed behaviour, and marker eligibility.

### Paper
Physical or digital paper within a Component. Owns page layout and sections, and determines which MarkSchemeVersions and QuestionItems apply to which PageImages.

### Session
Delivery sitting of an Exam/Component (e.g. date/time/region window). Used to scope Centres and Candidates for timetabling and regulatory reporting.

### Centre
Physical or virtual location where Candidates sit the exam.

### Candidate
A person taking the assessment. Owns CandidateID. Candidates may sit multiple Components and Sessions.

### Script
The full submission for a Candidate on a Component/Session: all Booklets and PageImages for that attempt. Owns ScriptID. Scripts are the root for traceability of all downstream artefacts.

### Booklet
Logical bundle of Pages belonging to one Script (main booklet, additional answer booklet, etc.).

### PageImage
Individual scanned or digital page. Must belong to exactly one Script (via ScriptID). CandidateID is reachable via the Script.

### QuestionItem
Smallest markable unit (question or sub-question). Linked to a MarkSchemeVersion and, through that, to a Component and Paper.

### MarkSchemeVersion
Versioned definition of scoring logic for a Component (tolerances, allowable annotations, mark types). Used for standardisation, re-marking, and audit replay.

### Marker
Human marker (AE) account. Owns MarkerID and has per-QIG eligibility controlled by the Marker Eligibility State Machine.

### Team
Group of Markers under a Team Leader / Principal Examiner structure. Team membership feeds supervision, sampling, and escalation workflows.

### Allocation
Work assignment linking one or more Responses to a Marker. Owns AllocationID. Allocation state is tracked separately from Response state.

### Response
Distinct unit of work presented to a Marker in one go. A Response always belongs to exactly one Script but may represent the whole Script or a part of it, depending on Component configuration.

### MarkRecord
Stored snapshot of marks for (Response, Marker, MarkSchemeVersion), including per-QuestionItem data. May be in draft or submitted state.

### Annotation
Visual or structural overlay applied to a PageImage and/or QuestionItem (ticks, crosses, comments). Always traceable back to ScriptID and CandidateID via Response/Script.

### AuditEvent
Append-only record of important actions and state transitions (ingest, QC, allocation, marking, exceptions, config changes). Must carry enough identifiers to reach ScriptID and CandidateID.

### ExceptionCase
Structured record of exceptions (missing pages, suspected malpractice, technical issues). Linked to Script and/or Response, with its own lifecycle and resolutions.

## Immutable Identifiers

All primary IDs below are opaque strings from the perspective of business logic. They are immutable once assigned and MUST NOT be reused.

### ScriptID
Identifies a single Script (all pages for a Candidate’s attempt on a Component/Session).

- Scope: Unique per deployment at minimum; recommended globally unique in the master core.
- Issued by: Ingestion engine when a Script is first created.
- Invariants:
  - Each Script has exactly one ScriptID.
  - ScriptID never changes, even if pages are added or exceptions are raised.
  - All Booklets, PageImages, Responses, MarkRecords, Annotations, and ExceptionCases MUST be traceable to ScriptID.

### CandidateID
Identifies a single Candidate.

- Scope: Unique per deployment.
- Issued by: Registration/identity subsystem.
- Invariants:
  - Each Script links to exactly one CandidateID.
  - CandidateID MUST be reachable from all key artefacts (Script, Response, MarkRecord, Annotation, AuditEvent, ExceptionCase).

### ComponentID
Identifies a Component.

- Scope: Unique per deployment.
- Issued by: Assessment setup tools.
- Invariants:
  - Components are versioned via MarkSchemeVersion, not ComponentID churn.
  - Scripts, Responses, Allocations MUST carry or reliably derive their ComponentID.

### MarkerID
Identifies a Marker (AE).

- Scope: Unique per deployment.
- Issued by: Marker onboarding / identity process.
- Invariants:
  - All Marker-facing artefacts (Allocations, MarkRecords, AuditEvents about marking) MUST reference MarkerID.
  - Eligibility and team membership are recorded per MarkerID.

### AllocationID
Identifies a single Allocation (assignment of work to a Marker).

- Scope: Unique per deployment.
- Issued by: Allocation engine.
- Invariants:
  - AllocationID is stable across state changes.
  - Every Allocation state transition MUST be auditable by AllocationID.

### ResponseID
Identifies a single Response (unit of marking work).

- Scope: Unique per deployment.
- Issued by: Ingestion or script→response decomposition.
- Invariants:
  - Response belongs to exactly one Script.
  - MarkRecords, Allocations, Annotations, and AuditEvents about marking MUST reference ResponseID.
  - ScriptID and CandidateID MUST be derivable from ResponseID via the Script.

