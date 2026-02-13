Feature: Config activation endpoint with RBAC
  As a ParityMark engineer
  I want acceptance checks for the config activation endpoint
  So that configuration activation behaviour and RBAC are enforced end-to-end

  @config @activation @phase1
  Scenario: Unauthenticated caller cannot activate config
    Given the API server is running for config tests with an active config for deployment "D1"
    And I am an anonymous config activation caller
    When I POST "/config/D1/versions/1/activate" to the config API server
    Then the config activation response status code is 401
    And the JSON config activation error code is "unauthenticated"

  @config @activation @phase1
  Scenario: Authenticated caller without activation permission cannot activate config
    Given the API server is running for config tests with an active config for deployment "D1"
    And I am an authenticated config caller without activation permission
    When I POST "/config/D1/versions/1/activate" to the config API server
    Then the config activation response status code is 403
    And the JSON config activation error code is "forbidden"

  @config @activation @phase1
  Scenario: Activation target deployment does not exist
    Given the API server is running for config tests with no deployments
    And I am an authorised config activator
    When I POST "/config/NON_EXISTENT/versions/1/activate" to the config API server
    Then the config activation response status code is 404
    And the JSON config activation error code is "deployment_not_found"

  @config @activation @phase1
  Scenario: Activation target version does not exist for an existing deployment
    Given the API server is running for config tests with an active config for deployment "D1"
    And I am an authorised config activator
    When I POST "/config/D1/versions/999/activate" to the config API server
    Then the config activation response status code is 404
    And the JSON config activation error code is "config_version_not_found"

  @config @activation @phase1
  Scenario: Authenticated activator can activate an existing config version
    Given the API server is running for config tests with an active config for deployment "D1"
    And I am an authorised config activator
    When I POST "/config/D1/versions/1/activate" to the config API server
    Then the config activation response status code is 200
    And the JSON config activation response contains an activated config version 1 for deployment "D1"
