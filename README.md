## AI Log Triage Agent (Serverless)

# Overview
AI Log Triage Agent is a serverless system that automatically scans application logs, detects error patterns, and produces structured evidence for incident investigation. The system runs on AWS using a scheduled Lambda function that analyzes CloudWatch logs and summarizes error activity within a defined time window.

This project demonstrates how serverless infrastructure and automated log analysis can be used to build the foundation of an AI-driven incident response system.

# Tech Stack
- TypeScript
- AWS Lambda
- Amazon EventBridge
- Amazon CloudWatch Logs
- AWS SAM (Serverless Application Model)
- AWS SDK v3

# Deployment
This project uses AWS SAM for deployment.

Build the application:
`sam build`

Deploy to AWS:
`sam deploy`
