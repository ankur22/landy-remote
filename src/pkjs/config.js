// Phone-side configuration controller.
//
// This module contains no Pebble or network globals. Tests inject a raw JLR
// client and memory storage; production passes the same raw client used by the
// watch bridge. The password is forwarded to login() once and never persisted.
(function () {
  'use strict';

  var CONFIG_URL = 'https://ankur22.github.io/landy-remote/config/';
  var SELECTED_VIN_KEY = 'jlr_selected_vin';
  var PIN_KEY = 'jlr_pin';
  var DISTANCE_UNIT_KEY = 'jlr_distance_unit';
  var TEMP_UNIT_KEY = 'jlr_temp_unit';
  var TYRE_UNIT_KEY = 'jlr_tyre_unit';
  var ANALYTICS_OFF_KEY = 'jlr_analytics_off';

  function typedError(code, message, cause) {
    var error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function globalStorage() {
    return (typeof localStorage !== 'undefined' && localStorage) ?
      localStorage : null;
  }

  function storageGet(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try { return storage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(storage, key, value) {
    if (!storage) return;
    try {
      if (value === null || value === undefined || value === '') {
        storage.removeItem(key);
      } else {
        storage.setItem(key, value);
      }
    } catch (err) {
      // The login itself may still be useful, but an unpersisted vehicle/PIN
      // would make the apparent success misleading, so surface the failure.
      throw typedError('storage_failure', 'Could not save configuration.', err);
    }
  }

  function clean(value) {
    return value === null || value === undefined ? '' :
      String(value).replace(/^\s+|\s+$/g, '');
  }

  function vehicleVin(vehicle) {
    if (!vehicle) return '';
    return clean(vehicle.vin || vehicle.VIN || vehicle.vehicleId).toUpperCase();
  }

  function parseResponse(response) {
    if (!response) return { action: 'cancel' };
    try {
      return JSON.parse(decodeURIComponent(response));
    } catch (err) {
      throw typedError('invalid_configuration',
        'The configuration response was invalid.', err);
    }
  }

  function selectVehicle(vehicles, requestedVin) {
    vehicles = vehicles || [];
    if (!vehicles.length) {
      throw typedError('no_vehicles', 'No vehicle was found on this account.');
    }
    requestedVin = clean(requestedVin).toUpperCase();
    if (!requestedVin && vehicles.length !== 1) {
      throw typedError('vehicle_selection_required',
        'Enter the VIN of the vehicle to use.');
    }
    if (!requestedVin) requestedVin = vehicleVin(vehicles[0]);
    for (var i = 0; i < vehicles.length; i++) {
      if (vehicleVin(vehicles[i]) === requestedVin) {
        return vehicleVin(vehicles[i]);
      }
    }
    throw typedError('vehicle_not_found',
      'That VIN is not on the signed-in account.');
  }

  function create(options) {
    options = options || {};
    var rawClient = options.rawClient;
    var storage = options.storage || globalStorage();

    if (!rawClient) {
      throw typedError('missing_client', 'A JLR client is required.');
    }

    // Display preferences are just that -- they say nothing to JLR and need no
    // session. Kept separate so they can be written without a sign-in.
    function savePreferences(payload) {
      storageSet(storage, DISTANCE_UNIT_KEY,
        payload.distanceUnit === 'km' ? 'km' : 'miles');
      storageSet(storage, TEMP_UNIT_KEY, payload.tempUnit === 'f' ? 'f' : 'c');
      storageSet(storage, TYRE_UNIT_KEY,
        (payload.tyreUnit === 'bar' || payload.tyreUnit === 'psi') ?
          payload.tyreUnit : 'kpa');
      // Opt-out is stored as a positive "off" flag so the absence of the key
      // means enabled -- matching analytics.js, which must agree exactly.
      storageSet(storage, ANALYTICS_OFF_KEY, payload.analytics === false ? '1' : null);
    }

    // URL the settings button opens, carrying enough state for the page to
    // reflect reality: current unit choices, whether we are signed in, and
    // whether a PIN is stored.
    //
    // Deliberately carries NO email, password or VIN. Query strings end up in
    // browser history and referrer headers, so nothing identifying goes here --
    // the page asks for credentials only when it actually needs them.
    function configUrl() {
      var signedIn = rawClient.isLoggedIn() ? '1' : '0';
      var pinStored = storageGet(storage, PIN_KEY) ? '1' : '0';
      var d = storageGet(storage, DISTANCE_UNIT_KEY) === 'km' ? 'km' : 'miles';
      var t = storageGet(storage, TEMP_UNIT_KEY) === 'f' ? 'f' : 'c';
      var pRaw = storageGet(storage, TYRE_UNIT_KEY);
      var p = (pRaw === 'bar' || pRaw === 'psi') ? pRaw : 'kpa';
      var analyticsOn = storageGet(storage, ANALYTICS_OFF_KEY) === '1' ? '0' : '1';
      return CONFIG_URL + '?si=' + signedIn + '&pin=' + pinStored +
        '&d=' + d + '&t=' + t + '&p=' + p + '&a=' + analyticsOn;
    }

    function save(payload, callback) {
      var email = clean(payload.email);
      var password = String(payload.password || '');
      var pin = clean(payload.pin);

      // Changing units should not cost a re-login. If we already hold a valid
      // session and no new credentials were supplied, this is a preferences-only
      // save: write them and stop. Re-authenticating to change a display unit
      // would mean typing a password to switch from miles to km.
      if (!password && rawClient.isLoggedIn()) {
        try {
          savePreferences(payload);
          if (payload.keepPin === true) {
            // Leave the stored PIN exactly as it is.
          } else if (payload.storePin === true) {
            if (!/^\d{4}$/.test(pin)) {
              callback(typedError('invalid_pin', 'Enter the four digit vehicle PIN.'));
              return;
            }
            storageSet(storage, PIN_KEY, pin);
          } else if (payload.clearPin === true) {
            storageSet(storage, PIN_KEY, null);
          }
        } catch (err) {
          callback(err);
          return;
        }
        callback(null, { action: 'save_preferences' });
        return;
      }

      if (!email || !password) {
        callback(typedError('credentials_required',
          'Enter your InControl email and password.'));
        return;
      }
      if (payload.storePin === true && !/^\d{4}$/.test(pin)) {
        callback(typedError('invalid_pin', 'Enter the four digit vehicle PIN.'));
        return;
      }

      rawClient.login(email, password, function (loginError) {
        // Do not retain our only password reference beyond this callback.
        password = null;
        if (loginError) {
          callback(typedError('login_failed',
            'Sign-in failed. Check your InControl credentials.', loginError));
          return;
        }
        rawClient.getVehicles(function (vehicleError, vehicles) {
          if (vehicleError) {
            callback(typedError('vehicle_lookup_failed',
              'Signed in, but could not load vehicles.', vehicleError));
            return;
          }
          var vin;
          try {
            vin = selectVehicle(vehicles, payload.vin);
            storageSet(storage, SELECTED_VIN_KEY, vin);
            storageSet(storage, PIN_KEY, payload.storePin === true ? pin : null);
            savePreferences(payload);
          } catch (err) {
            callback(err);
            return;
          }
          callback(null, {
            action: 'save',
            vin: vin,
            pinStored: payload.storePin === true
          });
        });
      });
    }

    function handleResponse(response, callback) {
      var payload;
      try {
        payload = parseResponse(response);
      } catch (err) {
        callback(err);
        return;
      }
      if (payload.action === 'cancel') {
        callback(null, { action: 'cancel' });
        return;
      }
      if (payload.action === 'logout') {
        rawClient.logout();
        try {
          storageSet(storage, SELECTED_VIN_KEY, null);
          storageSet(storage, PIN_KEY, null);
        } catch (storageError) {
          callback(storageError);
          return;
        }
        callback(null, { action: 'logout' });
        return;
      }
      if (payload.action !== 'save') {
        callback(typedError('invalid_configuration',
          'Unknown configuration action.'));
        return;
      }
      save(payload, callback);
    }

    return {
      handleResponse: handleResponse,
      configUrl: configUrl
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CONFIG_URL: CONFIG_URL,
      create: create,
      parseResponse: parseResponse,
      selectVehicle: selectVehicle
    };
  }
}());
