Feature: Assessment tree endpoint for HTTP assessment deployment
  As a ParityMark engineer
  I want acceptance checks for the assessment tree endpoint
  So that the assessment structure consumed by the Assessment Debug page is enforced end-to-end

  Background:
    Given the API server is running for assessment tests with an assessment tree for deployment "D_ASSESS_HTTP"
    And I am an authorised assessment tree viewer

  @api @assessment @phase1
  Scenario: Authorised assessment viewer can fetch an assessment tree with series, papers, QIGs and items
    When I GET "/assessment/D_ASSESS_HTTP/tree" from the assessment API server
    Then the assessment tree response status code is 200
    And the JSON assessment tree response contains a deployment "D_ASSESS_HTTP" with at least one series, paper, QIG and item
