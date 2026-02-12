Feature: Hardened dev helper for apps/web
  As a ParityMark engineer
  I want a single dev entrypoint that cleans up stale Next.js processes and locks
  So that starting the apps/web dev server is reliable and does not require manual port or lock cleanup

  Background:
    Given the ParityMark repository has a script file "scripts/dev-web.sh"
    And the script "scripts/dev-web.sh" is executable
    And the script "scripts/dev-web.sh" is wired in the root package.json as the "dev:web" script
    And the "dev:web" script is invoked via "pnpm run dev:web" at the repository root

  @dev_env @web @infra
  Scenario: Clean dev start when no prior dev server is running
    Given no process is currently listening on TCP port 3000 on the VPS
    And no process is currently listening on TCP port 3001 on the VPS
    And the directory "apps/web/.next/dev" does not contain a stale lock file
    When I run "pnpm run dev:web" from the repository root
    Then the script logs that it is checking for processes on ports 3000 and 3001
    And the script logs that no processes are found on ports 3000 and 3001
    And the script removes "apps/web/.next/dev" if it exists
    And the script starts "pnpm turbo dev --filter=web"
    And the Next.js dev server starts successfully on port 3000
    And the dev logs show a GET request to "/" returning HTTP 200

  @dev_env @web @infra
  Scenario: Clean dev restart when a stale dev server is holding port 3000
    Given there is an existing Next.js dev process listening on TCP port 3000 on the VPS
    And that process would normally prevent a new "next dev" from acquiring the dev lock
    When I run "pnpm run dev:web" from the repository root
    Then the script logs that it is checking for processes on ports 3000 and 3001
    And the script logs that it is killing the process or processes on port 3000
    And after the script has run, no process is listening on TCP port 3000 or 3001
    And the script removes "apps/web/.next/dev" if it exists
    And the script starts "pnpm turbo dev --filter=web"
    And the Next.js dev server starts successfully on port 3000
    And no "Unable to acquire lock" error is printed in the dev logs
    And the dev logs show a GET request to "/" returning HTTP 200
