import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secrets_manager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';

export class OdooEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const serviceName = 'my-service';
    const databaseName = 'odoo-db';
    const databaseUsername = 'odoo-admin';
    const stage = 'dev';

    const vpc = ec2.Vpc.fromLookup(this, 'dev-vpc', {vpcName: 'AriefhInfraStack/dev-vpc'});
    const appCidr = vpc.privateSubnets[0].ipv4CidrBlock;

    const databaseCredentialsSecret = new secrets_manager.Secret(this, 'DBCredentialsSecret', {
      secretName: `${serviceName}-${stage}-credentials`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: databaseUsername,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    const dbSG = new ec2.SecurityGroup(this, 'DBSG', { vpc });
    const appSG = new ec2.SecurityGroup(this, 'AppSG', { vpc });
    const lbSG = new ec2.SecurityGroup(this, 'LBSG', { vpc });
    dbSG.addIngressRule(ec2.Peer.securityGroupId(appSG.securityGroupId), ec2.Port.tcp(5432));
    appSG.addIngressRule(ec2.Peer.securityGroupId(lbSG.securityGroupId), ec2.Port.tcp(80));
    // appSG.addEgressRule(ec2.Peer.securityGroupId(dbSG.securityGroupId), ec2.Port.tcp(5432));
    // lbSG.addEgressRule(ec2.Peer.securityGroupId(appSG.securityGroupId), ec2.Port.tcp(80));

    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds-readme.html
    const rdsInstance = new rds.DatabaseInstance(this, 'OdooDB', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_14_5 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      databaseName: databaseName,
      maxAllocatedStorage: 200,
      publiclyAccessible: false,
      securityGroups: [dbSG]
    });

    const cluster = new ecs.Cluster(this, 'OdooEcsCluster', {vpc: vpc});

    const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'OdooTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    const container = fargateTaskDefinition.addContainer("OdooCntr", {
      image: ecs.ContainerImage.fromRegistry("odoo:16.0"),
      environment: {
        HOST: rdsInstance.dbInstanceEndpointAddress,
      },
      secrets: {
        USER: ecs.Secret.fromSecretsManager(databaseCredentialsSecret, 'username'),
        PASSWORD: ecs.Secret.fromSecretsManager(databaseCredentialsSecret, 'password')
      },
      portMappings: [
        {
          containerPort: 8069,
        }
      ],
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: fargateTaskDefinition,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [appSG],
      desiredCount: 2,
      maxHealthyPercent: 200,
      minHealthyPercent: 100
    });
    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', { vpc, internetFacing: true, securityGroup: lbSG });
    const listener = lb.addListener('Listener', { port: 80 });
    service.registerLoadBalancerTargets(
      {
        containerName: 'OdooCntr',
        containerPort: 8069,
        newTargetGroupId: 'ECS',
        listener: ecs.ListenerConfig.applicationListener(listener, {
          protocol: elbv2.ApplicationProtocol.HTTP,
          healthCheck: {
            // seems like odoo returns 303
            healthyHttpCodes: '200,303'
          }
        }),
      },
    );
  }
}
