/// <reference path="../typings/globals/moment/index.d.ts" />

module ImprovedInitiative {
    export interface ISavedCreature {
        Id: number;
        Statblock: IStatBlock;
        MaxHP: number;
        CurrentHP: number;
        TemporaryHP: number;
        Initiative: number;
        Alias: string;
        IndexLabel: number;
        Tags: string[];
        Hidden: boolean;
    }
    export interface ISavedEncounter<T> {
        Name: string;
        ActiveCreatureId: number;
        RoundCounter?: number;
        DisplayTurnTimer?: boolean;
        Creatures: T[];
    }

    export class Encounter {
        constructor(userPollQueue: UserPollQueue) {
            this.Rules = new DefaultRules();
            this.Creatures = ko.observableArray<ICreature>();
            this.CreatureCountsByName = [];
            this.ActiveCreature = ko.observable<ICreature>();
            this.ActiveCreatureStatblock = ko.computed(() => {
                return this.ActiveCreature()
                    ? this.ActiveCreature().StatBlock()
                    : StatBlock.Empty();
            });

            var autosavedEncounter = Store.Load<ISavedEncounter<ISavedCreature>>(Store.AutoSavedEncounters, this.EncounterId);
            if (autosavedEncounter) {
                this.LoadSavedEncounter(autosavedEncounter, userPollQueue);
            }
        }

        Rules: IRules;
        TurnTimer = new TurnTimer();
        Creatures: KnockoutObservableArray<ICreature>;
        CreatureCountsByName: KnockoutObservable<number>[];
        ActiveCreature: KnockoutObservable<ICreature>;
        ActiveCreatureStatblock: KnockoutComputed<IStatBlock>;
        State: KnockoutObservable<string> = ko.observable('inactive');
        RoundCounter: KnockoutObservable<number> = ko.observable(0);
        EncounterId = $('html')[0].getAttribute('encounterId');
        Socket: SocketIOClient.Socket = io();

        SortByInitiative = () => {
            this.Creatures.sort((l, r) => (r.Initiative() - l.Initiative()) ||
                (r.InitiativeBonus - l.InitiativeBonus));
            this.QueueEmitEncounter();
        }

        private emitEncounterTimeoutID;

        private EmitEncounter = () => {
            this.Socket.emit('update encounter', this.EncounterId, this.SavePlayerDisplay());
            Store.Save<ISavedEncounter<ISavedCreature>>(Store.AutoSavedEncounters, this.EncounterId, this.Save());
        }

        QueueEmitEncounter = () => {
            clearTimeout(this.emitEncounterTimeoutID);
            this.emitEncounterTimeoutID = setTimeout(this.EmitEncounter, 10);
        }

        MoveCreature = (creature: ICreature, index: number) => {
            var currentPosition = this.Creatures().indexOf(creature);
            var newInitiative = creature.Initiative();
            var passedCreature = this.Creatures()[index];
            if (index > currentPosition && passedCreature && passedCreature.Initiative() < creature.Initiative()) {
                newInitiative = passedCreature.Initiative();
            }
            if (index < currentPosition && passedCreature && passedCreature.Initiative() > creature.Initiative()) {
                newInitiative = passedCreature.Initiative();
            }
            this.Creatures.remove(creature);
            this.Creatures.splice(index, 0, creature);
            creature.Initiative(newInitiative);
            this.QueueEmitEncounter();
            return newInitiative;
        }

        AddCreature = (creatureJson: IStatBlock, event?, savedCreature?: ISavedCreature) => {
            console.log("adding %O to encounter", creatureJson);
            var creature: ICreature;
            if (creatureJson.Player && creatureJson.Player.toLocaleLowerCase() === 'player') {
                creature = new PlayerCharacter(creatureJson, this, savedCreature);
            } else {
                creature = new Creature(creatureJson, this, savedCreature);
            }
            if (event && event.altKey) {
                creature.Hidden(true);
            }
            this.Creatures.push(creature);

            this.QueueEmitEncounter();
            return creature;
        }

        RequestInitiative = (playercharacter: ICreature, userPollQueue: UserPollQueue) => {
            userPollQueue.Add({
                requestContent: `Initiative Roll for ${playercharacter.ViewModel.DisplayName()} (${playercharacter.InitiativeBonus.toModifierString()}): <input class='response' type='number' value='${this.Rules.Check(playercharacter.InitiativeBonus)}' />`,
                inputSelector: '.response',
                callback: (response: any) => {
                    playercharacter.Initiative(parseInt(response));
                }
            });
        }

        StartEncounter = () => {
            this.SortByInitiative();
            this.State('active');
            this.RoundCounter(1);
            this.ActiveCreature(this.Creatures()[0]);
            this.TurnTimer.Start();
            this.QueueEmitEncounter();
        }

        EndEncounter = () => {
            this.State('inactive');
            this.ActiveCreature(null);
            this.TurnTimer.Stop();
            this.QueueEmitEncounter();
        }

        RollInitiative = (userPollQueue: UserPollQueue) => {
            // Foreaching over the original array while we're rearranging it
            // causes unpredictable results- dupe it first.
            var creatures = this.Creatures().slice();
            if (this.Rules.GroupSimilarCreatures) {
                var initiatives = []
                creatures.forEach(
                    c => {
                        if (initiatives[c.StatBlock().Name] === undefined) {
                            initiatives[c.StatBlock().Name] = c.RollInitiative(userPollQueue);
                        }
                        c.Initiative(initiatives[c.StatBlock().Name]);
                    }
                )
            } else {
                creatures.forEach(c => {
                    c.RollInitiative(userPollQueue);
                });
            }
        }

        NextTurn = () => {
            var appInsights = window["appInsights"];
            appInsights.trackEvent("TurnCompleted");
            var nextIndex = this.Creatures().indexOf(this.ActiveCreature()) + 1;
            if (nextIndex >= this.Creatures().length) {
                nextIndex = 0;
                this.RoundCounter(this.RoundCounter() + 1);
            }
            this.ActiveCreature(this.Creatures()[nextIndex]);
            this.TurnTimer.Reset();
            this.QueueEmitEncounter();
        }

        PreviousTurn = () => {
            var previousIndex = this.Creatures().indexOf(this.ActiveCreature()) - 1;
            if (previousIndex < 0) {
                previousIndex = this.Creatures().length - 1;
                this.RoundCounter(this.RoundCounter() - 1);
            }
            this.ActiveCreature(this.Creatures()[previousIndex]);
            this.QueueEmitEncounter();
        }

        Save: (name?: string) => ISavedEncounter<ISavedCreature> = (name?: string) => {
            var activeCreature = this.ActiveCreature();
            return {
                Name: name || this.EncounterId,
                ActiveCreatureId: activeCreature ? activeCreature.Id : -1,
                RoundCounter: this.RoundCounter(),
                Creatures: this.Creatures().map<ISavedCreature>(c => {
                    return {
                        Id: c.Id,
                        Statblock: c.StatBlock(),
                        MaxHP: c.MaxHP,
                        CurrentHP: c.CurrentHP(),
                        TemporaryHP: c.TemporaryHP(),
                        Initiative: c.Initiative(),
                        Alias: c.Alias(),
                        IndexLabel: c.IndexLabel,
                        Tags: c.Tags(),
                        Hidden: c.Hidden()
                    }
                })
            };
        }

        SavePlayerDisplay = (name?: string) => {
            var hideMonstersOutsideEncounter = Store.Load(Store.User, "HideMonstersOutsideEncounter");
            var activeCreature = this.ActiveCreature();
            var roundCounter = Store.Load(Store.User, "PlayerViewDisplayRoundCounter") ? this.RoundCounter() : null;
            return {
                Name: name || this.EncounterId,
                ActiveCreatureId: activeCreature ? activeCreature.Id : -1,
                RoundCounter: roundCounter,
                DisplayTurnTimer: Store.Load(Store.User, "PlayerViewDisplayTurnTimer"),
                Creatures: this.Creatures()
                    .filter(c => {
                        if (c.Hidden()) {
                            return false;
                        }
                        if (hideMonstersOutsideEncounter && this.State() == 'inactive' && !c.IsPlayerCharacter) {
                            return false;
                        }
                        return true;
                    })
                    .map<CombatantPlayerViewModel>(c => new CombatantPlayerViewModel(c))
            };
        }

        LoadSavedEncounter = (savedEncounter: ISavedEncounter<ISavedCreature>, userPollQueue: UserPollQueue) => {
            let legacyCreatureIndex = savedEncounter["ActiveCreatureIndex"];
            if (legacyCreatureIndex != undefined && legacyCreatureIndex != -1) {
                savedEncounter.ActiveCreatureId = this.Creatures()[legacyCreatureIndex].Id;
            }
            let savedEncounterIsActive = savedEncounter.ActiveCreatureId != -1;
            let currentEncounterIsActive = this.State() == 'active';

            savedEncounter.Creatures.forEach(c => {
                let combatant = this.AddCreature(c.Statblock, null, c);
                if (currentEncounterIsActive) {
                    combatant.RollInitiative(userPollQueue);
                }
            });
            
            if (currentEncounterIsActive) {
                this.SortByInitiative();
            }
            else {
                if (savedEncounterIsActive) {
                    this.State('active');
                    this.ActiveCreature(this.Creatures().filter(c => c.Id == savedEncounter.ActiveCreatureId).pop());
                    this.TurnTimer.Start();
                }
                this.RoundCounter(savedEncounter.RoundCounter || 1);
            }
        }

        ClearEncounter = () => {
            if (confirm("Remove all creatures and end encounter?")) {
                this.Creatures.removeAll();
                this.CreatureCountsByName = [];
                this.EndEncounter();
            }
        }
    }
}