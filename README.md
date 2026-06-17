### 🚀 SnipeBot 2.0: Real-Time Deal Tracker

SnipeBot 2.0 is an automated monitoring system designed to track and notify users of new listings on major European secondary marketplaces in real-time.

#### **Core Functionality**

* **Multi-Platform Monitoring:** Actively scrapes and monitors real-time search results from **Vinted.de** and **Kleinanzeigen.de**.
* **Intuitive Command Interface:** Handles user search criteria via Discord slash commands, prefix commands, or direct mentions within a dedicated channel.
* **High-Precision Filtering:** Instantly filters incoming listings based on specific attributes including:
* **Category & Brand:** Precise matching against defined catalog hierarchies.
* **Size & Gender:** Targeted filtering to match user requirements.
* **Price:** Threshold-based alerts in Euro to ensure you never miss a bargain.


* **Instant Notifications:** Delivers filtered listings directly to Discord via rich embeds, ensuring immediate visibility the moment a matching item is published.

#### **Technical Pipeline**

* **Deployment-Ready:** Optimized for 24/7 cloud hosting via **Render.com** with integrated health-check endpoints for automated uptime monitoring via **UptimeRobot**.
* **Configurable Environment:** Decoupled architecture utilizing secure `.env` management for platform-specific tokens and configuration settings.

