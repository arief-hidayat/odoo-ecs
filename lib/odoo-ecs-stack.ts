import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secrets_manager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import { ListenerCertificate } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Duration } from 'aws-cdk-lib';

export class OdooEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const serviceName = 'my-service';
    const databaseName = 'odoodb';
    const databaseAdmin = 'odooadmin';
    const stage = 'dev';
    const emailAddress = 'mr.arief.hidayat@gmail.com';

    const firstTime = false;
    const desiredCount = firstTime ? 1 : 1;
    // const desiredCount = firstTime ? 1 : 2;
    const skipBootstrap = firstTime ? 'no' : 'yes';
    const loadDemoData = firstTime ? 'yes' : 'no';

    const vpc = ec2.Vpc.fromLookup(this, 'dev-vpc', {vpcName: 'AriefhInfraStack/dev-vpc'});

    const dbSG = new ec2.SecurityGroup(this, 'DBSG', { vpc });
    const appSG = new ec2.SecurityGroup(this, 'AppSG', { vpc });
    const lbSG = new ec2.SecurityGroup(this, 'LBSG', { vpc });
    dbSG.addIngressRule(ec2.Peer.securityGroupId(appSG.securityGroupId), ec2.Port.tcp(5432));
    appSG.addIngressRule(ec2.Peer.securityGroupId(lbSG.securityGroupId), ec2.Port.tcp(80));

    const dbAdminCredsSecret = new secrets_manager.Secret(this, 'DBAdminCredsSecret', {
      secretName: `${serviceName}-${stage}-admin-credentials`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: databaseAdmin,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds-readme.html
    const rdsInstance = new rds.DatabaseInstance(this, 'OdooDB', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_14_5 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      credentials: rds.Credentials.fromSecret(dbAdminCredsSecret),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      databaseName: databaseName,
      maxAllocatedStorage: 200,
      publiclyAccessible: false,
      securityGroups: [dbSG]
    });


    const odooCluster = new ecs.Cluster(this, 'OdooEcsCluster', {vpc: vpc});

    const odooTaskDefinition = new ecs.FargateTaskDefinition(this, 'OdooTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
    });
    const odooPwdSecret = new secrets_manager.Secret(this, 'OdooAppPwdSecret', {
      secretName: `odoo-${stage}-app-pwd`, 
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          email: emailAddress,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });
    // https://github.com/bitnami/containers/tree/main/bitnami/odoo#configuration
    const odooContainer = odooTaskDefinition.addContainer("OdooCntr", {
      image: ecs.ContainerImage.fromRegistry("bitnami/odoo:15.0.20221210-debian-11-r7"),
      environment: {
        ODOO_SKIP_BOOTSTRAP: skipBootstrap,
        ODOO_SKIP_MODULES_UPDATE: 'no',
        ODOO_LOAD_DEMO_DATA: loadDemoData,
        ODOO_DATABASE_HOST: rdsInstance.dbInstanceEndpointAddress,
        ODOO_DATABASE_NAME: databaseName,
        ALLOW_EMPTY_PASSWORD: 'no',
      },
      secrets: {
        ODOO_DATABASE_USER: ecs.Secret.fromSecretsManager(dbAdminCredsSecret, 'username'),
        ODOO_DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbAdminCredsSecret, 'password'),
        ODOO_EMAIL: ecs.Secret.fromSecretsManager(odooPwdSecret, 'email'),
        ODOO_PASSWORD: ecs.Secret.fromSecretsManager(odooPwdSecret, 'password'),
      },
      portMappings: [
        {
          containerPort: 8069,
        }
      ],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'Odoo' }),
    });

    const odooService = new ecs.FargateService(this, 'OdooService', {
      cluster: odooCluster,
      taskDefinition: odooTaskDefinition,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [appSG],
      desiredCount: desiredCount,
      maxHealthyPercent: 200,
      minHealthyPercent: 50
    });
    odooService.node.addDependency(rdsInstance);

    const odooLb = new elbv2.ApplicationLoadBalancer(this, 'OdooLB', { vpc, internetFacing: true, securityGroup: lbSG });
    const odooListener = odooLb.addListener('OdooListener', { port: 80 });
    const odooTargetGroup = odooListener.addTargets('Odoo', {
      port: 80,
      targetGroupName: 'OdooTarget',
      targets: [odooService.loadBalancerTarget({
        containerName: 'OdooCntr',
        containerPort: 8069,
      })],
      deregistrationDelay: Duration.seconds(5),
    });
    odooTargetGroup.configureHealthCheck({
      healthyHttpCodes: '200,303', 
      timeout: Duration.seconds(5), 
      interval: Duration.seconds(10), 
      healthyThresholdCount: 2
    });

    const odooScaling = odooService.autoScaleTaskCount({ minCapacity: desiredCount, maxCapacity: 10 });
    odooScaling.scaleOnCpuUtilization('OdooCpuScaling', {
      targetUtilizationPercent: 60,
    });
    odooScaling.scaleOnRequestCount('OdooRequestScaling', {
      requestsPerTarget: 200,
      targetGroup: odooTargetGroup,
    });
    new cdk.CfnOutput(this, 'odooLoadBalancer', {
      value: `http://${odooLb.loadBalancerDnsName}`,
      description: 'Odoo Load Balancer',
    });
    new cdk.CfnOutput(this, 'odooAppSecretArn', {
      value: odooPwdSecret.secretFullArn || '',
      description: 'Odoo User App Password ARN',
    });
    new cdk.CfnOutput(this, 'dbCredsArn', {
      value: dbAdminCredsSecret.secretFullArn || '',
      description: 'DB Credentials ARN',
    });
    new cdk.CfnOutput(this, 'dbEndpoint', {
      value: rdsInstance.dbInstanceEndpointAddress,
      description: 'DB Endpoint (Private)',
    });

    // for dev only
    if(stage == 'dev') {
      const pgAdminSecret = new secrets_manager.Secret(this, 'PgAdminSecret', {
        secretName: `pgadmin-${stage}-creds`, 
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            email: emailAddress,
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: 'password'
        }
      });
      const pgAdminCluster = new ecs.Cluster(this, 'PgAdminEcsCluster', {vpc: vpc});

      const pgAdminTaskDefinition = new ecs.FargateTaskDefinition(this, 'PgAdminTaskDef', {
        memoryLimitMiB: 1024,
        cpu: 512,
      });
      const pgAdminContainer = pgAdminTaskDefinition.addContainer("PgAdminCntr", {
        image: ecs.ContainerImage.fromRegistry("dpage/pgadmin4:6.18"),
        secrets: {
          PGADMIN_DEFAULT_EMAIL: ecs.Secret.fromSecretsManager(pgAdminSecret, 'email'),
          PGADMIN_DEFAULT_PASSWORD: ecs.Secret.fromSecretsManager(pgAdminSecret, 'password'),
        },
        portMappings: [
          {
            containerPort: 80,
          }
        ],
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'pgadmin' }),
      });

      const pgAdminService = new ecs.FargateService(this, 'PgAdminService', {
        cluster: pgAdminCluster,
        taskDefinition: pgAdminTaskDefinition,
        assignPublicIp: false,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroups: [appSG],
        desiredCount: 1
      });

      const pgAdminLb = new elbv2.ApplicationLoadBalancer(this, 'PGAdminLB', { vpc, internetFacing: true, securityGroup: lbSG });
      const listener = pgAdminLb.addListener('PgAdminListener', { port: 80 });
      const pgAdminTargetGroup = listener.addTargets('PgAdminTG', {
        port: 80,
        targetGroupName: 'PgAdminTG',
        targets: [pgAdminService.loadBalancerTarget({
          containerName: 'PgAdminCntr',
          containerPort: 80,
        })],
      });
      pgAdminTargetGroup.configureHealthCheck({healthyHttpCodes: '200', path: "/misc/ping"});

      new cdk.CfnOutput(this, 'pgAdminLoadBalancerUrl', {
        value: `http://${pgAdminLb.loadBalancerDnsName}`,
        description: 'PgAdmin Load Balancer URL',
      });
      new cdk.CfnOutput(this, 'pgAdminSecretArn', {
        value: pgAdminSecret.secretFullArn || '',
        description: 'PgAdmin User Email Address',
      });
    }
  }
}
