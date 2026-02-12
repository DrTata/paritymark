Feature: API DB-backed health endpoint in Phase 0
  As a ParityMark engineer
  I want an acceptance check for the API health endpoint in DB-backed mode
  So that the Phase 0 DB-backed health behaviour is enforced end-to-end

  Background:
    Given the API server is running in DB-backed health mode with a reachable Postgres database

  @api @health @db @phase0
  Scenario: Health endpoint reports DB up when Postgres is available
    When I GET "/health" from the API server
    Then the response status code is 200
    And the JSON response body has property "status" equal to "ok"
    And the JSON response body has property "db" equal to "up"
