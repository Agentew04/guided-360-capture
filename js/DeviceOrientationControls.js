import {
	Euler,
	EventDispatcher,
	MathUtils,
	Quaternion,
	Vector3
} from 'https://unpkg.com/three@0.132.0/build/three.module.js';

const _zee = new Vector3( 0, 0, 1 );
const _euler = new Euler();
const _q0 = new Quaternion();
const _q1 = new Quaternion( - Math.sqrt( 0.5 ), 0, 0, Math.sqrt( 0.5 ) );

const _changeEvent = { type: 'change' };

class DeviceOrientationControls extends EventDispatcher {

	constructor( object ) {

		super();

		if ( window.isSecureContext === false ) {

			console.error( 'THREE.DeviceOrientationControls: DeviceOrientationEvent is only available in secure contexts (https)' );

		}

		const scope = this;

		const EPS = 0.000001;
		const lastQuaternion = new Quaternion();

		this.object = object;
		this.object.rotation.reorder( 'YXZ' );

		this.enabled = true;

		this.deviceOrientation = {};
		this.screenOrientation = 0;

		this.alphaOffset = 0;

		const onDeviceOrientationChangeEvent = function ( event ) {

			scope.deviceOrientation = event;

		};

		const onScreenOrientationChangeEvent = function () {

			scope.screenOrientation = window.orientation || 0;

		};

		const setObjectQuaternion = function ( quaternion, alpha, beta, gamma, orient ) {

			_euler.set( beta, alpha, - gamma, 'YXZ' );

			quaternion.setFromEuler( _euler );

			quaternion.multiply( _q1 );

			quaternion.multiply( _q0.setFromAxisAngle( _zee, - orient ) );

		};

		this.connect = function () {

			onScreenOrientationChangeEvent();

			if ( window.DeviceOrientationEvent !== undefined && typeof window.DeviceOrientationEvent.requestPermission === 'function' ) {

				window.DeviceOrientationEvent.requestPermission().then( function ( response ) {

					if ( response == 'granted' ) {

						window.addEventListener( 'orientationchange', onScreenOrientationChangeEvent );
						window.addEventListener( 'deviceorientation', onDeviceOrientationChangeEvent );

					}

				} ).catch( function ( error ) {

					console.error( 'THREE.DeviceOrientationControls: Unable to use DeviceOrientation API:', error );

				} );

			} else {

				window.addEventListener( 'orientationchange', onScreenOrientationChangeEvent );
				window.addEventListener( 'deviceorientation', onDeviceOrientationChangeEvent );

			}

			scope.enabled = true;

		};

		this.disconnect = function () {

			window.removeEventListener( 'orientationchange', onScreenOrientationChangeEvent );
			window.removeEventListener( 'deviceorientation', onDeviceOrientationChangeEvent );

			scope.enabled = false;

		};

		this.update = function () {

			if ( scope.enabled === false ) return;

			const device = scope.deviceOrientation;

			if ( device ) {

				const alpha = device.alpha ? MathUtils.degToRad( device.alpha ) + scope.alphaOffset : 0; // Z

				const beta = device.beta ? MathUtils.degToRad( device.beta ) : 0; // X'

				const gamma = device.gamma ? MathUtils.degToRad( device.gamma ) : 0; // Y''

				const orient = scope.screenOrientation ? MathUtils.degToRad( scope.screenOrientation ) : 0; // O

				setObjectQuaternion( scope.object.quaternion, alpha, beta, gamma, orient );

				if ( 8 * ( 1 - lastQuaternion.dot( scope.object.quaternion ) ) > EPS ) {

					lastQuaternion.copy( scope.object.quaternion );
					scope.dispatchEvent( _changeEvent );

				}

			}

		};

		this.dispose = function () {

			scope.disconnect();

		};

		this.connect();

	}

}

export { DeviceOrientationControls };