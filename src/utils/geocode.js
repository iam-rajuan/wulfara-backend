const https = require('https');

/**
 * Geocode an address using Google Maps API
 * @param {string} address - The physical address to geocode
 * @returns {Promise<Object|null>} - Returns object with { coordinates: [lng, lat], formattedAddress: string } or null
 */
const geocodeAddress = (address) => {
  return new Promise((resolve, reject) => {
    if (!process.env.MAPS_API_KEY) {
      console.warn('MAPS_API_KEY is not defined. Geocoding skipped.');
      return resolve(null);
    }

    const encodedAddress = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${process.env.MAPS_API_KEY}`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          
          if (parsedData.status === 'OK' && parsedData.results.length > 0) {
            const result = parsedData.results[0];
            const lat = result.geometry.location.lat;
            const lng = result.geometry.location.lng;
            const formattedAddress = result.formatted_address;
            
            // MongoDB expects coordinates in [longitude, latitude] order
            resolve({
              coordinates: [lng, lat],
              formattedAddress
            });
          } else {
            console.warn('Geocoding failed for address:', address, 'Status:', parsedData.status);
            resolve(null);
          }
        } catch (error) {
          console.error('Error parsing geocode response:', error);
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error('Error in geocoding request:', err.message);
      resolve(null);
    });
  });
};

module.exports = geocodeAddress;
