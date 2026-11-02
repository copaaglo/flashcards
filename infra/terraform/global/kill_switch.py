"""Stops every running EC2 VM and RDS database tagged Project = flashcards.

AWS Budgets calls this through SNS when the month's spend passes the kill switch amount
(kill-switch.tf). To see what it would stop without stopping anything:
    aws lambda invoke --function-name flashcards-kill-switch --payload '{"dry_run": true}' \
        --cli-binary-format raw-in-base64-out /dev/stdout
"""

import boto3

TAG_KEY = "Project"
TAG_VALUE = "flashcards"


def handler(event, context):
    dry_run = bool(event.get("dry_run"))
    ec2 = boto3.client("ec2")
    rds = boto3.client("rds")

    reservations = ec2.describe_instances(
        Filters=[
            {"Name": f"tag:{TAG_KEY}", "Values": [TAG_VALUE]},
            {"Name": "instance-state-name", "Values": ["running"]},
        ]
    )["Reservations"]
    vms = [i["InstanceId"] for r in reservations for i in r["Instances"]]

    databases = [
        db["DBInstanceIdentifier"]
        for db in rds.describe_db_instances()["DBInstances"]
        if db["DBInstanceStatus"] == "available"
        and {"Key": TAG_KEY, "Value": TAG_VALUE} in db.get("TagList", [])
    ]

    if not dry_run:
        if vms:
            ec2.stop_instances(InstanceIds=vms)
        for db in databases:
            rds.stop_db_instance(DBInstanceIdentifier=db)

    result = {"dry_run": dry_run, "stopped_vms": vms, "stopped_databases": databases}
    print(result)
    return result
