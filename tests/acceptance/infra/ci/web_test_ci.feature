Feature: Web CI - unit tests for apps/web
  As a ParityMark engineer
  I want the apps/web unit tests to run in CI on every push and pull request to main
  So that changes which break the web unit test baseline are caught before merging

  Background:
    Given the ParityMark repository has a GitHub Actions workflow "Web Lint"
    And the "Web Lint" workflow is configured to run on pushes to "main"
    And the "Web Lint" workflow is configured to run on pull requests targeting "main"
    And the workflow defines a "test" job for apps/web
    And the "test" job installs dependencies with "pnpm install"
    And the "test" job runs "pnpm --filter web test"

  @ci @web @infra
  Scenario: Web test job runs for pushes to main
    Given a commit is pushed to the "main" branch of the ParityMark repository
    When GitHub Actions runs the "Web Lint" workflow for that commit
    Then the "test" job is executed
    And the "test" job runs "pnpm --filter web test"
    And the "test" job completes successfully with exit code 0
    And the job log shows that the Jest test suites for apps/web have passed

  @ci @web @infra
  Scenario: Web test job runs for pull requests targeting main
    Given a pull request is opened with its base branch set to "main"
    When GitHub Actions runs the "Web Lint" workflow for that pull request
    Then the "test" job is executed
    And the "test" job runs "pnpm --filter web test"
    And the "test" job completes successfully with exit code 0
    And the job log shows that the Jest test suites for apps/web have passed
