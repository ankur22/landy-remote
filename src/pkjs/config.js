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

    function save(payload, callback) {
      var email = clean(payload.email);
      var password = String(payload.password || '');
      var pin = clean(payload.pin);
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
            // Display preference only -- no effect on what we request from JLR.
            storageSet(storage, DISTANCE_UNIT_KEY,
              payload.distanceUnit === 'km' ? 'km' : 'miles');
            storageSet(storage, TEMP_UNIT_KEY, payload.tempUnit === 'f' ? 'f' : 'c');
            storageSet(storage, TYRE_UNIT_KEY,
              (payload.tyreUnit === 'bar' || payload.tyreUnit === 'psi') ?
                payload.tyreUnit : 'kpa');
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
      handleResponse: handleResponse
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
