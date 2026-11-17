# Contributing to npm-publisher

Thank you for considering a contribution to npm-publisher! Pull requests, issues and comments are welcome. For pull requests, please:

* Add tests for new features and bug fixes
* Follow the existing style
* Separate unrelated changes into multiple pull requests

See the existing issues for things to start contributing.

For bigger changes, please make sure you start a discussion first by creating an issue and explaining the intended change.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately using the [security policy](SECURITY.md).

## Maintenance and triage

The Atlassian Artifacts Team maintains this project. The team's on-call triages GitHub issues and pull requests, requests any missing information, and routes changes to the appropriate maintainer for review. Include reproduction steps for bugs and the purpose and validation of proposed changes in pull requests.

This is an Atlassian publishing utility. Running the publishing workflow requires access to the configured Artifactory deployment and package-specific npm trusted-publisher configuration. Local checks use mocked network requests and npm commands and do not require publishing credentials.

## Local checks

Use Node.js 24.15 or later on the Node.js 24 line, or Node.js 26 or later:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

## Contributor License Agreement

Atlassian requires contributors to sign a Contributor License Agreement, known as a CLA. This serves as a record stating that the contributor is entitled to contribute the code/documentation/translation to the project and is willing to have it used in distributions and derivative works (or is willing to transfer ownership).

Prior to accepting your contributions we ask that you please follow the appropriate link below to digitally sign the CLA. The Corporate CLA is for those who are contributing as a member of an organization and the individual CLA is for those contributing as an individual.

* [CLA for corporate contributors](https://opensource.atlassian.com/corporate)
* [CLA for individuals](https://opensource.atlassian.com/individual)
