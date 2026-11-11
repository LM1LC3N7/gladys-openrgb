// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, device and feature names,
// answers to a command), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

/** Several messages one after the other, in each language. */
export const join = (...messages) => {
  const parts = messages.filter(Boolean);
  return both(parts.map((m) => m.en).join(' '), parts.map((m) => m.fr).join(' '));
};

export const FEATURE_NAMES = {
  light: both('Light', 'Lumière'),
  color: both('Color', 'Couleur'),
  mode: both('Effect mode', 'Mode d’effet'),
  profile: both('Profile', 'Profil'),
};

export const SERVER_NAME = both('OpenRGB profiles', 'Profils OpenRGB');

export const STATUS = {
  noServer: both(
    'Type the address of the computer running OpenRGB (SDK server started).',
    'Saisissez l’adresse de l’ordinateur où tourne OpenRGB (serveur SDK démarré).',
  ),
  badServer: both(
    'The address of the server is not valid: an IP address or a name, with :port if not 6742.',
    'L’adresse du serveur n’est pas valide : une adresse IP ou un nom, avec :port si ce n’est pas 6742.',
  ),
  configUnread: both(
    'The configuration could not be read from Gladys; trying again.',
    'La configuration n’a pas pu être lue depuis Gladys ; nouvel essai.',
  ),
  dataUnread: both(
    'The /data file could not be read; read again in a moment (nothing is overwritten).',
    'Le fichier de /data n’a pas pu être lu ; relu dans un instant (rien n’est écrasé).',
  ),
  connected: (count) =>
    both(
      `Connected to OpenRGB: ${count} controller(s) read.`,
      `Connecté à OpenRGB : ${count} contrôleur(s) lu(s).`,
    ),
  unreachable: both(
    'The OpenRGB SDK server does not answer: is OpenRGB running, with its SDK server started (SDK Server tab, or --server)?',
    'Le serveur SDK d’OpenRGB ne répond pas : OpenRGB est-il lancé, avec son serveur SDK démarré (onglet SDK Server, ou --server) ?',
  ),
  protocol: both(
    'The server answers, but not as an OpenRGB SDK server: check the address and the port.',
    'Le serveur répond, mais pas comme un serveur SDK d’OpenRGB : vérifiez l’adresse et le port.',
  ),
  skipped: (count) =>
    both(
      `${count} controller(s) left out (no per-LED color mode, or two alike without a serial).`,
      `${count} contrôleur(s) laissé(s) de côté (sans mode couleur par LED, ou deux identiques sans numéro de série).`,
    ),
  retry: (seconds) => both(`Next try in ${seconds} s.`, `Nouvel essai dans ${seconds} s.`),
};

export const ANSWERS = {
  confirmed: both('Done: the read shows it.', 'Fait : la lecture le montre.'),
  unconfirmed: both(
    'Sent, without confirmation: the read does not show it yet.',
    'Envoyé, sans confirmation : la lecture ne le montre pas encore.',
  ),
  offKept: both(
    'Off sent, not shown yet: it is sent again at the next reads.',
    'Extinction envoyée, pas encore visible : elle est renvoyée aux prochaines lectures.',
  ),
  offWaiting: both(
    'Off not sent yet (server not reached): it is kept and sent at the next reads.',
    'Extinction pas encore envoyée (serveur injoignable) : elle est gardée et envoyée aux prochaines lectures.',
  ),
  nothingSent: both('Nothing sent.', 'Rien envoyé.'),
  cancelled: both(
    'Nothing sent: an Off came after it.',
    'Rien envoyé : une extinction est arrivée après.',
  ),
  notFound: both(
    'Nothing sent: this controller is not on the OpenRGB server now.',
    'Rien envoyé : ce contrôleur n’est plus sur le serveur OpenRGB.',
  ),
  noServer: both(
    'Nothing sent: no OpenRGB server configured.',
    'Rien envoyé : aucun serveur OpenRGB configuré.',
  ),
  modesOff: both(
    'Nothing sent: changing the mode is off (option “Allow the effect modes”).',
    'Rien envoyé : le changement de mode est désactivé (option « Autoriser les modes d’effet »).',
  ),
  profilesOff: both(
    'Nothing sent: loading a profile is off (option “Allow loading the profiles”).',
    'Rien envoyé : le chargement d’un profil est désactivé (option « Autoriser le chargement des profils »).',
  ),
  unknownMode: both(
    'Nothing sent: this controller has no such mode.',
    'Rien envoyé : ce contrôleur n’a pas ce mode.',
  ),
  unknownProfile: both(
    'Nothing sent: OpenRGB has no such profile.',
    'Rien envoyé : OpenRGB n’a pas ce profil.',
  ),
  busy: both(
    'Nothing sent: too many commands in progress, try again.',
    'Rien envoyé : trop de commandes en cours, réessayez.',
  ),
  badValue: both('Nothing sent: value not valid.', 'Rien envoyé : valeur non valide.'),
  profileSent: both(
    'Profile load sent (OpenRGB does not tell which profile is active).',
    'Chargement du profil envoyé (OpenRGB ne dit pas quel profil est actif).',
  ),
  oldServer: both(
    'Nothing sent: this OpenRGB is too old for profiles (SDK protocol 2 or later).',
    'Rien envoyé : cet OpenRGB est trop ancien pour les profils (protocole SDK 2 ou plus).',
  ),
};

export const TEST = {
  planned: both(
    'Read less than an interval ago, before a restart: the next read comes at its time.',
    'Lu il y a moins d’un intervalle, avant un redémarrage : la prochaine lecture vient à son heure.',
  ),
  recent: both(
    'Last read (less than an interval ago):',
    'Dernière lecture (il y a moins d’un intervalle) :',
  ),
};
