Feature: API hello audit evidence endpoint in Phase 0
  As a ParityMark engineer
  I want an acceptance check for the hello audit evidence endpoint
  So that the Phase 0 hello audit behaviour is enforced end-to-end

  Background:
    Given the API server is running with hello audit enabled and a reachable Postgres database

  @api @audit @phase0
  Scenario: Latest hello audit event matches the version endpoint metadata
    When I request the API version and latest hello audit event
    Then the hello audit endpoint returns an event whose payload meta version matches the version endpoint
