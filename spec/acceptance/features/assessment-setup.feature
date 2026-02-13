@parity
Feature: Assessment setup

  Background:
    Given a Deployment "D1" exists
    And Deployment "D1" has an ACTIVE ConfigVersion
    And an admin user "admin_1" exists in Deployment "D1"

  Scenario: Admin creates series/paper/QIG/items
    When "admin_1" creates Series "S1"
    And "admin_1" creates Paper "P1" in Series "S1"
    And "admin_1" creates QIG "Q1" in Paper "P1"
    And "admin_1" creates Item "Q1a" with max mark 3 in QIG "Q1"
    Then QIG "Q1" contains item "Q1a"
    And an audit event exists for "ASSESSMENT_STRUCTURE_UPDATED" with actor "admin_1"
