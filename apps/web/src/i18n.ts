export type Locale = 'en-GB' | 'fr-FR';

type AssessmentDebugMessages = {
  title: string;
  description: string;
  loadButtonIdle: string;
  loadButtonLoading: string;
  summaryHeading: string;
};

type DebugPageMessages = {
  title: string;
  identityHeading: string;
  errorPrefix: string;
  loading: string;
  unauthenticated: string;
  panelsHeading: string;
  linkHealthLabel: string;
  linkVersionLabel: string;
  linkIdentityLabel: string;
  linkConfigLabel: string;
};

type ConfigPageMessages = {
  titlePrefix: string;
  activeHeading: string;
  activeErrorPrefix: string;
  activeLoading: string;
  activeUnauthenticated: string;
  activeForbidden: string;
  activeDeploymentNotFoundPrefix: string;
  activeDeploymentNotFoundSuffix: string;
  activeNotFoundPrefix: string;
  activeNotFoundSuffix: string;
  activeSummaryDeploymentLabel: string;
  activeSummaryActiveVersionLabel: string;
  versionsHeading: string;
  versionsLoading: string;
  versionsUnauthenticated: string;
  versionsForbidden: string;
};

export type WebMessages = {
  assessmentDebug: AssessmentDebugMessages;
  debug: DebugPageMessages;
  config: ConfigPageMessages;
};

export const defaultLocale: Locale = 'en-GB';

const messages: Record<Locale, WebMessages> = {
  'en-GB': {
    assessmentDebug: {
      title: 'Assessment Debug',
      description:
        'Debug view for the assessment tree (Series \u2192 Papers \u2192 QIGs \u2192 Items).',
      loadButtonIdle: 'Load Assessment Tree',
      loadButtonLoading: 'Loading\u2026',
      summaryHeading: 'Assessment tree summary',
    },
    debug: {
      title: 'System debug dashboard',
      identityHeading: 'Identity',
      errorPrefix: 'Failed to load identity',
      loading: 'Loading identity...',
      unauthenticated:
        'You are not authenticated. No user or permissions are available.',
      panelsHeading: 'Panels',
      linkHealthLabel: 'API health',
      linkVersionLabel: 'API version',
      linkIdentityLabel: 'Identity & permissions',
      linkConfigLabel: 'Active config viewer',
    },
    config: {
      titlePrefix: 'Config for deployment',
      activeHeading: 'Active config',
      activeErrorPrefix: 'Failed to load config',
      activeLoading: 'Loading active config...',
      activeUnauthenticated:
        'You are not authenticated. Cannot load active config.',
      activeForbidden:
        'You do not have permission to view active config.',
      activeDeploymentNotFoundPrefix: 'Deployment',
      activeDeploymentNotFoundSuffix: 'was not found.',
      activeNotFoundPrefix: 'No active config found for deployment',
      activeNotFoundSuffix: '.',
      activeSummaryDeploymentLabel: 'Deployment:',
      activeSummaryActiveVersionLabel: 'Active version:',
      versionsHeading: 'Config versions',
      versionsLoading: 'Loading versions...',
      versionsUnauthenticated:
        'You are not authenticated. Cannot load versions.',
      versionsForbidden:
        'You do not have permission to view config versions.',
    },
  },
  'fr-FR': {
    // Stub locale: strings intentionally different so tests can assert locale switching.
    assessmentDebug: {
      title: 'Débogage des évaluations',
      description:
        "Vue de débogage pour l\u2019arbre d\u2019évaluation (Séries \u2192 Copies \u2192 QIGs \u2192 Items).",
      loadButtonIdle: "Charger l'arbre d'évaluation",
      loadButtonLoading: 'Chargement\u2026',
      summaryHeading: "Résumé de l'arbre d'évaluation",
    },
    debug: {
      title: 'Tableau de débogage du système',
      identityHeading: 'Identité',
      errorPrefix: 'Échec du chargement de l\u2019identité',
      loading: "Chargement de l'identité...",
      unauthenticated:
        "Vous n'êtes pas authentifié. Aucun utilisateur ni permissions disponibles.",
      panelsHeading: 'Panneaux',
      linkHealthLabel: "État de l'API",
      linkVersionLabel: "Version de l'API",
      linkIdentityLabel: 'Identité & permissions',
      linkConfigLabel: 'Visionneuse de config active',
    },
    config: {
      titlePrefix: 'Config (FR) pour le déploiement',
      activeHeading: 'Config active (FR)',
      activeErrorPrefix: 'Échec du chargement de la config',
      activeLoading: 'Chargement de la config active...',
      activeUnauthenticated:
        "Vous n'êtes pas authentifié. Impossible de charger la config active.",
      activeForbidden:
        "Vous n'avez pas l'autorisation de voir la config active.",
      activeDeploymentNotFoundPrefix: 'Déploiement',
      activeDeploymentNotFoundSuffix: 'introuvable.',
      activeNotFoundPrefix:
        'Aucune config active trouvée pour le déploiement',
      activeNotFoundSuffix: '.',
      activeSummaryDeploymentLabel: 'Déploiement :',
      activeSummaryActiveVersionLabel: 'Version active :',
      versionsHeading: 'Versions de config',
      versionsLoading: 'Chargement des versions...',
      versionsUnauthenticated:
        "Vous n'êtes pas authentifié. Impossible de charger les versions.",
      versionsForbidden:
        "Vous n'avez pas l'autorisation de voir les versions de config.",
    },
  },
};

export function getMessages(locale: Locale = defaultLocale) {
  const base = messages[defaultLocale];
  return messages[locale] ?? base;
}
