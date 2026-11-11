# OpenRGB

Intègre à Gladys l’éclairage RGB d’un ordinateur piloté par
[OpenRGB](https://openrgb.org) (carte mère, RAM, carte graphique,
ventilateurs, rubans LED, clavier, souris…), par le **serveur SDK** d’OpenRGB
sur votre réseau local : sans compte, sans cloud.

> Jamais testé avec un vrai appareil : construit d’après le protocole du
> serveur SDK d’OpenRGB (tel que le lit la bibliothèque openrgb-sdk). Dites-nous
> sur le forum comment ça se passe. Sans lien avec OpenRGB.

## Ce que vous obtenez

Un appareil par contrôleur qu’OpenRGB voit, avec :

- **Lumière** : allumer / éteindre. Éteindre met toutes les LED en noir dans
  le mode direct ; allumer remet la dernière couleur vue allumée (blanc si
  aucune) ;
- **Couleur** : toutes les LED du contrôleur à cette couleur, dans le mode
  direct ;
- **Mode d’effet** : le mode actif (Direct, Static, Rainbow…), affiché ; le
  changer demande l’option **Autoriser les modes d’effet**.

Et, si OpenRGB a des profils enregistrés, un appareil **Profils OpenRGB** :
choisir un profil le charge (tous les appareils d’un coup), seulement avec
l’option **Autoriser le chargement des profils**. OpenRGB ne dit pas quel
profil est actif : la liste ne montre pas de valeur lue.

Aucune fonctionnalité n’est un interrupteur. Les lumières suivent « éteindre
les lumières » comme les autres.

Non gérés : la luminosité, les couleurs LED par LED ou par zone, la vitesse et
le sens des effets, le redimensionnement des zones. L’intégration n’envoie
jamais de demande d’enregistrement (ni mode enregistré dans l’appareil, ni
profil créé ou supprimé) ; certains appareils gardent seuls leur dernier mode.

Laissés de côté (l’état le dit) : un contrôleur sans mode « couleur par LED »
(il ne peut être ni coloré ni éteint ainsi), et deux contrôleurs identiques
sans numéro de série au même emplacement (jamais d’écriture sur le mauvais).

## Configuration

1. Dans OpenRGB, onglet **SDK Server**, cliquez sur **Start Server** (ou lancez
   `openrgb --server`, au besoin avec `--server-port`). Cochez le démarrage
   automatique si OpenRGB démarre avec l’ordinateur.
2. Donnez à cet ordinateur une adresse fixe dans votre box.
3. Dans **Adresse de l’ordinateur OpenRGB**, saisissez son adresse IP (ou son
   nom), avec `:port` seulement si ce n’est pas le 6742.
4. Enregistrez, puis ajoutez les appareils depuis l’onglet **Découverte**.

Le serveur SDK n’a pas de mot de passe : tout appareil de votre réseau peut le
piloter. Gardez-le sur un réseau de confiance, ne l’ouvrez pas sur Internet.

L’état dit combien de contrôleurs ont été lus, ceux laissés de côté, un
serveur qui ne répond pas (et quand il est réessayé), un service qui répond
mais pas comme OpenRGB.

**Tester la connexion** lit le serveur, ou montre la dernière lecture si elle
date de moins d’un intervalle (jamais plus vite que l’intervalle).

## Quel contrôleur un appareil pilote

OpenRGB numérote ses contrôleurs, mais ce numéro change quand il refait sa
détection. Un appareil est donc lié à son contrôleur par une empreinte du
fabricant, du nom et du numéro de série (ou, sans numéro de série, de
l’emplacement qu’OpenRGB affiche : bus et adresse). Avant chaque écriture, le
contrôleur est relu à son numéro ; si ce n’est plus lui, toute la liste est
relue pour le retrouver ; s’il n’y est plus : « rien envoyé ». Une lecture sert
aux écritures qui suivent sur la même connexion jusqu’à la lecture périodique
suivante (plus 5 s), tant qu’OpenRGB ne signale pas que sa liste a changé : une
scène sur plusieurs contrôleurs part sans une lecture par contrôleur. Les
commandes passent l’une après l’autre (jamais entremêlées) ; juste après un
changement de liste, sur un serveur lent, les dernières d’une scène peuvent
répondre « rien envoyé » (les extinctions, elles, partent l’une après l’autre
et sont gardées). « Allumer » relit toujours l’état avant de décider : une
scène qui allume plusieurs contrôleurs sur un serveur lent peut n’en régler que
certains, même sans changement de liste (mesuré : 3, 2 ou 1 sur 5 avec des
réponses en 300, 500 ou 900 ms ; les autres répondent « rien envoyé »).
Espacez ces actions dans la scène (une attente d’une à deux secondes entre
deux allumages).

Si OpenRGB change l’ordre de ses contrôleurs sans le signaler, une commande
peut toucher, jusqu’à la lecture suivante, le contrôleur qui a pris la place :
une extinction peut ainsi éteindre un voisin. Elle n’est alors pas annoncée
faite : elle est gardée, et la lecture suivante (ou un nouveau clic) éteint le
bon contrôleur ; le voisin reste éteint jusqu’à ce que vous le rallumiez.

Un appareil USB rebranché sur un autre port, sans numéro de série, peut donc
apparaître comme un nouvel appareil dans la Découverte.

## Éteindre

Éteindre ne demande aucune option. Il passe avant les autres commandes et
avant les lectures (une lecture bloquée depuis 1 s est coupée), et annule les
commandes de ce contrôleur encore en attente : rien de demandé avant
l’extinction ne part après elle. Il fonctionne aussi avant que la
configuration soit lue (l’adresse gardée dans `/data` sert).

Si la lecture qui suit ne montre pas le contrôleur éteint, l’extinction est
gardée (dans `/data`) et renvoyée par les lectures suivantes, 3 fois au plus.
Une commande plus récente partie vers ce contrôleur (allumer, couleur, mode)
ou un profil demandé après l’extinction et chargé arrêtent ces renvois. Un
profil demandé avant une extinction ne part plus après elle. Au démarrage, une
extinction gardée n’est renvoyée que si elle date de moins de 10 minutes.

Une extinction est refusée seulement quand le contrôleur n’est plus sur le
serveur (ou y est en double, sans numéro de série). Si le serveur ne répond pas, elle est gardée et envoyée aux lectures
suivantes (3 fois au plus).

## Réponses à une commande

- « Fait » : la lecture qui suit montre la valeur demandée ;
- « Envoyé, sans confirmation » : parti, mais la lecture ne le montre pas
  (encore) ;
- « Rien envoyé » : refusé avant tout envoi (option désactivée, contrôleur
  introuvable, valeur non valide, extinction arrivée après, serveur
  injoignable).

## Données gardées

Dans `/data` : l’adresse du serveur, l’heure de la dernière lecture (un
redémarrage ne relit pas plus tôt que l’intervalle), pour chaque contrôleur
son numéro dans OpenRGB et sa dernière couleur allumée, les extinctions à
renvoyer. Ni nom, ni numéro de série.
