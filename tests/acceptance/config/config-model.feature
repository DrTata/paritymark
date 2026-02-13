Feature: Config model active config resolution
  As a ParityMark engineer
  I want acceptance checks for the config active endpoint
  So that the Phase 1 config backbone behaviour is enforced end-to-end

  @config @phase1
  Scenario: Deployment code does not exist
    Given the API server is running for config tests with no deployments
    And I am an authorised config viewer
    When I GET "/config/NON_EXISTENT/active" from the config API server
    Then the config response status code is 404
    And the JSON config error code is "deployment_not_found"

  @config @phase1
  Scenario: Deployment exists but no ACTIVE config
    Given the API server is running for config tests with deployment "D_NO_ACTIVE" and no active config version
    And I am an authorised config viewer
    When I GET "/config/D_NO_ACTIVE/active" from the config API server
    Then the config response status code is 404
    And the JSON config error code is "active_config_not_found"

  @config @phase1
  Scenario: Deployment has an ACTIVE config with artifacts
    Given the API server is running for config tests with an active config for deployment "D1"
    And I am an authorised config viewer
    When I GET "/config/D1/active" from the config API server
    Then the config response status code is 200
    And the JSON config response contains an active config for deployment "D1" with permission_matrix and branding artifacts

  @config @phase1 @rbac
  Scenario: Unauthenticated caller cannot access active config
    Given the API server is running for config tests with an active config for deployment "D1"
    And I am an anonymous config caller
    When I GET "/config/D1/active" from the config API server
    Then the config response status code is 401
    And the JSON config error code is "unauthenticated"

  @config @phase1 @rbac
  Scenario: Authenticated user without config view permission cannot access active config
    Given the API server is running for config tests with an active config for deployment "D1"
    And I am an authenticated config caller without config view permission
    When I GET "/config/D1/active" from the config API server
    Then the config response status code is 403
    And the JSON config error code is "forbidden"
