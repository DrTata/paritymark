Feature: Assessment tree endpoint for HTTP assessment deployment
  As a ParityMark engineer
  I want acceptance checks for the assessment tree endpoint
  So that the assessment structure consumed by the Assessment Debug page is enforced end-to-end

  Background:
    Given the API server is running for assessment tests with an assessment tree for deployment "D_ASSESS_HTTP"

  @api @assessment @phase1
  Scenario: Authorised assessment viewer can fetch an assessment tree with series, papers, QIGs and items
    Given I am an authorised assessment tree viewer
    When I GET "/assessment/D_ASSESS_HTTP/tree" from the assessment API server
    Then the assessment tree response status code is 200
    And the JSON assessment tree response contains a deployment "D_ASSESS_HTTP" with at least one series, paper, QIG and item
    And an assessment tree view audit event exists for deployment "D_ASSESS_HTTP" and user "assessment-viewer-1"

  @api @assessment @phase1
  Scenario: Assessment tree requires authentication
    When I GET "/assessment/D_ASSESS_HTTP/tree" from the assessment API server
    Then the assessment tree response status code is 401
    And the JSON assessment tree permission error is "unauthenticated" for permission "assessment.view"
    And a permission denied audit event exists for permission "assessment.view" and reason "unauthenticated"

  @api @assessment @phase1
  Scenario: Assessment tree requires assessment.view permission
    Given I am an unauthorised assessment tree viewer
    When I GET "/assessment/D_ASSESS_HTTP/tree" from the assessment API server
    Then the assessment tree response status code is 403
    And the JSON assessment tree permission error is "forbidden" for permission "assessment.view"
    And a permission denied audit event exists for permission "assessment.view" and reason "missing_permission"

  @api @assessment @phase1
  Scenario: Assessment tree returns deployment_not_found for unknown deployment
    Given I am an authorised assessment tree viewer
    When I GET "/assessment/D_UNKNOWN/tree" from the assessment API server
    Then the assessment tree response status code is 404
    And the JSON assessment tree error code is "deployment_not_found"
