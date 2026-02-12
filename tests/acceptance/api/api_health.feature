Feature: API health and version endpoints in Phase 0
  As a ParityMark engineer
  I want basic acceptance checks for the API health and version endpoints in non-DB mode
  So that the Phase 0 baseline behaviour is enforced end-to-end

  Background:
    Given the API server is running in non-DB health mode

  @api @health @phase0
  Scenario: Health endpoint returns OK status in non-DB mode
    When I GET "/health" from the API server
    Then the response status code is 200
    And the JSON response body has property "status" equal to "ok"

  @api @version @phase0
  Scenario: Version endpoint exposes service metadata in test environment
    When I GET "/version" from the API server
    Then the response status code is 200
    And the JSON response body has property "service" equal to "api"
    And the JSON response body has property "name" equal to "api"
    And the JSON response body has property "env" equal to "test"
    And the JSON response body has property "version" which is a non-empty string
