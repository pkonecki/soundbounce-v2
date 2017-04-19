/**
 * Created by pb on 14/04/2017.
 */
import request from 'request';
import querystring from 'querystring';
import secrets from '../../config/secrets/secrets';
import randomString from './util/randomString';
import _debug from 'debug';
const debug = _debug('app:server:auth');

const stateKey = 'spotify_auth_state',
	spotifyScopes = [
		'user-read-playback-state',
		'user-modify-playback-state',
		'playlist-read-private',
		'playlist-read-collaborative',
		'playlist-modify-public',
		'playlist-modify-private',
		'user-follow-modify',
		'user-follow-read',
		'user-library-read',
		'user-library-modify',
		'user-read-private',
		'user-read-birthdate',
		'user-read-email',
		'user-top-read'
	];

export default (app) => {
	app.get('/login', (req, res) => {
		const state = randomString(16);

		res.cookie(stateKey, state);

		if (req.query.redirectUrl) {
			res.cookie('redirectUrl', req.query.redirectUrl);
		}

		// request authorization from spotify
		res.redirect('https://accounts.spotify.com/authorize?' +
			querystring.stringify({
				response_type: 'code',
				client_id: secrets.spotify.clientId,
				scope: spotifyScopes.join(' '),
				redirect_uri: secrets.spotify.redirectUri,
				state: state
			}));
	});

	// spotify will reply on this endpoint (malicious users won't know the secret state)
	app.get('/spotify-oauth-callback', (req, res) => {
		const {code, state} = req.query;
		const storedState = req.cookies ? req.cookies[stateKey] : null;
		if (state === null || state !== storedState) {
			res.redirect('/error/invalid-oauth-state');
		} else {
			res.clearCookie(stateKey);
			const authOptions = {
				url: 'https://accounts.spotify.com/api/token',
				form: {
					code: code,
					redirect_uri: secrets.spotify.redirectUri,
					grant_type: 'authorization_code'
				},
				headers: {
					'Authorization': 'Basic ' +
					(new Buffer(secrets.spotify.clientId + ':' + secrets.spotify.clientSecret).toString('base64'))
				},
				json: true
			};

			request.post(authOptions, (error, response, body) => {
				if (!error && response.statusCode === 200) {
					const accessToken = body.access_token,
						refreshToken = body.refresh_token;

					const redirectUrl = req.cookies ? req.cookies['redirectUrl'] : null;
					if (redirectUrl) {
						res.clearCookie('redirectUrl');
					}
					debug('spotify auth successful, redirecting client');
					// pass the token to the browser to make requests from there
					res.redirect((redirectUrl || '/') + '#' +
						querystring.stringify({
							access_token: accessToken,
							refresh_token: refreshToken
						}));
				} else {
					res.redirect('/error/invalid-token');
				}
			});
		}
	});
};