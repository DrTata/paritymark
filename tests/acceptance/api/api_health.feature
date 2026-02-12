Feature: API health endpoint in Phase 0
  As a ParityMark engineer
  I want a basic acceptance check for the API health endpoint in non-DB mode
  So that the Phase 0 baseline health behaviour is enforced end-to-end

  Background:
    Given the API server is running in non-DB health mode

  @api @health @phase0
  Scenario: Health endpoint returns OK status in non-DB mode
    When I GET "/health" from the API server
    Then the response status code is 200
    And the JSON response body has property "status" equal to "ok"
