/**
 * Created by paulbarrass on 25/04/2017.
 */
import _debug from 'debug';
import update from 'react-addons-update';
import {createStore, applyMiddleware, combineReducers, compose} from 'redux';
import roomReducer, {
	roomFullSync,
	roomTrackAddOrVote,
	roomUserJoin,
	roomUserLeave,
	roomChat,
	roomNowPlayingEnded,
	actions as roomActions
} from '../../../src/redux/modules/shared/room';
import {uniq, flatten, take} from 'lodash';
import shortid from 'shortid';
import moment from 'moment';

import {TrackActivity} from '../data/schema';

let debug = _debug('soundbounce:activeroom');

export default class ActiveRoom {
	constructor({room, app}) {
		this.room = room;
		this.app = app;
		this.id = room.get('id');
		this.name = room.get('name');
		this.reduxStore = null;
		this.timeoutId = null;
		debug = _debug(`soundbounce:activeroom:${this.id}`);
	}

	// called when first user joins a room so room goes active
	startup() {
		this.createAndPopulateReduxStore();
		const {reduxStore, room} = this;
		const existingState = reduxStore.getState();
		let lastRoomActivityTimestamp = room.get('shutdownAt');

		if (!lastRoomActivityTimestamp && room.get('isActive')) {
			// room wasn't shut down correctly, since it's active but no shutdownAt
			debug(`Room '${this.name}' startup - room was not shut down correctly.`);
			lastRoomActivityTimestamp = room.get('updatedAt');
		}

		if (lastRoomActivityTimestamp) {
			// we're resuming a room so will defo have at least some state
			// was there a track playing when we shutdown?
			if (existingState.playlist.length > 0) {
				// ok resume the track as if we just left
				const msSinceShutdown = moment().valueOf() - moment(lastRoomActivityTimestamp).valueOf();
				debug(`Room '${this.name}' startup - resuming track that was playing ${moment.duration(msSinceShutdown).humanize()} ago`);

				// either start now or resume where we were
				const nowPlayingStartedAt = existingState.nowPlayingStartedAt ?
					existingState.nowPlayingStartedAt + msSinceShutdown :
					moment.valueOf();

				this.setReduxRoomStateDuringStartup({
					...existingState,
					nowPlayingStartedAt
				});

				this.beginNextTrackTimer();
			}
		}
		// save default state so it's sent to first client
		room.set('reduxState', reduxStore.getState());
		room.set('isActive', true);
		room.set('shutdownAt', null);
		return room.save();
	}

	// called when last user leaves a room so shuts down (pauses) until someone rejoins
	shutdown() {
		debug(`Room '${this.name}' shutdown.`);
		// remove from the rooms list
		this.removeFromList();
		// clear next track timer
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = null;
		}
		// store the state in the db
		this.room.set('reduxState', this.reduxStore.getState());
		this.room.set('isActive', false);
		this.room.set('shutdownAt', new Date());
		return this.room.save();
	}

	beginNextTrackTimer = () => {
		const {reduxStore} = this;
		const state = reduxStore.getState();
		if (state.playlist.length === 0) {
			debug('Error - beingNextTrackTimer called with no tracks in playlist');
			return;
		}

		this.room.set('reduxState', state);
		this.room.set('nowPlayingTrackId', state.playlist[0].id);
		this.room.save();

		// find the duration for playing track from the db
		this.app.tracks.findTracksInDb(
			[state.playlist[0].id]
		).then(tracks => {
			const {duration} = tracks[0];
			const ms = state.nowPlayingStartedAt - moment().valueOf() + duration;
			if (this.timeoutId) {
				clearTimeout(this.timeoutId);
			}
			this.timeoutId = setTimeout(this.nextTrackTimerTick, ms);
		});
	};

	nextTrackTimerTick = () => {
		const {reduxStore} = this;
		const state = reduxStore.getState();
		const trackWithVotes = state.playlist[0];
		const numTracksRemaining = state.playlist.length - 1;

		this.timeoutId = null; // timeout just ticked

		// log play to database
		TrackActivity.create({
			type: 'play',
			detail: {
				// store who was listening at the time
				listeners: this.app.connections
					.getConnectedUsersForRoom(this.id)
					.map(user => user.get('id')),
				trackWithVotes
			},
			userId: null,
			roomId: this.id,
			trackId: trackWithVotes.id
		});

		let finishingTrackDuration = Promise.resolve(null);

		// if there's a next track, find its duration
		if (state.playlist.length > 1) {
			finishingTrackDuration = this.app.tracks.findTracksInDb(
				[state.playlist[0].id]
			).then(tracks => tracks[0].get('duration'));
			this.room.set('nowPlayingTrackId', state.playlist[1].id);
		} else {
			this.room.set('nowPlayingTrackId', null);
		}

		finishingTrackDuration.then((finishingTrackDuration) => {
			// fire the event to update our redux store
			this.reduxStore.dispatch(roomNowPlayingEnded({trackWithVotes, finishingTrackDuration}));
			// save the redux state to the db
			this.room.set('reduxState', this.reduxStore.getState());
			this.room.save();

			// save the now playing track id for the homepage view etc
			// if the playlist before we finished had more than one track
			if (numTracksRemaining > 0) {
				this.beginNextTrackTimer();
			}
		});
	};

	// create a redux store on server that will match that on client, so we
	// can pass action messages around and know the state is in sync
	createAndPopulateReduxStore() {
		const reducer = roomReducer;
		this.reduxStore = createStore(reducer);
		const existingState = this.room.get('reduxState');
		if (existingState !== null) {
			this.setReduxRoomStateDuringStartup(existingState);
		} else {
			// sync with default state
			this.setReduxRoomStateDuringStartup(this.reduxStore.getState())
		}
	}

	// a 'fake' sync action used to populate the server's room state during room startup
	setReduxRoomStateDuringStartup(newState) {
		this.reduxStore.dispatch(roomFullSync({
			room: {
				reduxState: newState,
				listeners: []
			}
		}));
	}

	// get a full state object that allows the client to render everything in this room without
	// any further immediate api calls.
	// so room state, plus short form for tracks, artists and users mentioned
	getFullSync() {
		const reduxState = this.reduxStore.getState();
		this.room.set('reduxState', reduxState);

		const roomPlain = this.room.get({plain: true});
		// send back the plain sequelize object which includes the jsonb for the 'reduxState'
		const room = {
			...roomPlain,
			listeners: this.app.connections
				.getConnectedUsersForRoom(this.id)
				.map(user => user.get('id'))
		};

		const userIdsInActionLog = reduxState.actionLog
			.filter(al => al.payload['userId'])
			.map(al => al.payload.userId);

		const users = this.app.users.getUsersToSendWithRoomSync(
			uniq([...room.listeners, ...userIdsInActionLog], room.id)
		);

		const trackIdsInActionLog = reduxState.actionLog
			.filter(al => al.payload['trackIds'])
			.map(al => al.payload.trackIds);

		const trackIdsInPlaylist = reduxState.playlist.map(pt => pt.id);
		const trackIdsInRecentlyPlayed = reduxState.recentlyPlayed.map(pt => pt.id);

		const tracks = this.app.tracks.findTracksInDb(
			uniq(flatten([...trackIdsInActionLog,
						  ...trackIdsInPlaylist,
						  ...trackIdsInRecentlyPlayed]))
		);

		return Promise.all([users, tracks]).then(([users, tracks]) => ({
			room,
			users,
			tracks
		})).catch(err => {
			debug('Error in getFullSync: ', err);
		});
	}

	// client sending a message to this room
	handleRoomEventMessage({sender, event}) {
		if (event.type === 'addOrVote') {
			let {trackIds} = event;
			if (trackIds.length === 0) {
				return;
			}
			// limit to 50 in one hit (spotify api limit)
			trackIds = take(trackIds, 50);
			// ensure they're in our database
			this.app.tracks.findInDbOrQuerySpotifyApi(trackIds).then(tracks => {

				const playlistWasEmptyBefore = this.reduxStore.getState().playlist.length === 0;
				this.emitUserEvent(roomTrackAddOrVote({
					userId: sender.get('id'),
					// some tracks may have failed so only
					// send back ids from the results
					trackIds: tracks.map(t => t.get('id')),
				}), {
					tracks: tracks.map(t => t.get({plain: true}))
				});

				if (playlistWasEmptyBefore) {
					this.beginNextTrackTimer();
				}
			});
		}
		if (event.type === 'chat') {
			const {text} = event;
			if (text === null || text === '') {
				return;
			}
			this.emitUserEvent(roomChat({userId: sender.get('id'), text}));
		}
	}

	emitUserEvent = (reduxAction, supplementaryData = {}) => {
		const {emit, app, id} = this;
		const {userId} = reduxAction.payload;

		// add timestamp and id (on server only, clients don't generate timestamps)
		const actionWithTimestamp = update(reduxAction, {
			timestamp: {$set: new Date()},
			id: {$set: shortid.generate()}
		});

		const socketsForUser = app.connections.getAllSocketsForUserId(userId);
		let getUserInfoPromise = null;
		if (socketsForUser.length > 0) {
			// we have a socket connected for this user
			// so get user data from there instead of db hit
			const user = socketsForUser[0].authenticatedUser.get({plain: true});
			getUserInfoPromise = Promise.resolve([{
				id: user.id,
				nickname: user.nickname,
				avatar: user.avatar
			}]);
		} else {
			// couldn't find this user connected, so fetch from db
			getUserInfoPromise = app.users.getUsersToSendWithRoomSync([userId], id);
		}

		getUserInfoPromise.then(users => {
			// tell client to dispatch action
			emit('room:event', {
				reduxAction: actionWithTimestamp,
				users,
				...supplementaryData
			});
		});

		// dispatch the same action on server too
		this.reduxStore.dispatch(actionWithTimestamp);
	};

	emitUserJoin = ({userId}) => (this.emitUserEvent(roomUserJoin(userId)));
	emitUserLeave = ({userId}) => (this.emitUserEvent(roomUserLeave(userId)));

	// emit an event over the network to every client that is in this room
	emit = (eventName, args) => {
		this.app.io.to(`room:${this.id}`).emit(eventName, args);
	};
}
