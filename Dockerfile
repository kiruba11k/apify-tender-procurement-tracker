# Apify base image with Node.js 18 + Chromium
FROM apify/actor-node:18

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source
COPY . ./

# Run
CMD npm start
