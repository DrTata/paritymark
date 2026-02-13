@parity @security
Feature: Identity and RBAC

  Background:
    Given a Deployment "D1" exists
    And Deployment "D1" has an ACTIVE ConfigVersion

  Scenario: Admin assigns AE role scoped to QIG
    Given an admin user "admin_1" exists in Deployment "D1"
    When "admin_1" creates Series "S1"
    And "admin_1" creates Paper "P1" in Series "S1"
    And "admin_1" creates QIG "Q1" in Paper "P1"
    And "admin_1" creates user "ae_1"
    And "admin_1" assigns role AE to user "ae_1" scoped to QIG "Q1"
    Then user "ae_1" can view QIG "Q1"
    And an audit event exists for "ROLE_ASSIGNED" with actor "admin_1"

  Scenario: AE cannot access unassigned QIG
    Given user "ae_1" has role AE assigned only to QIG "Q1"
    When "ae_1" requests to view QIG "Q2"
    Then the system denies access with reason "FORBIDDEN"
